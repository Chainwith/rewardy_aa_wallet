// eth_transfer_with_fee.ts
import "dotenv/config";
import { ethers } from "ethers";

const rewardyAbi = [
  "function nonce() view returns (uint256)",
  "function executeWithFee((address to,uint256 value,bytes data)[] calls,(address token,uint256 amount,address receiver) fee,uint256 deadline,bytes signature) payable",
] as const;

const erc20Abi = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
] as const;

type CallInput = [string, bigint, string];

let provider: ethers.JsonRpcProvider,
  firstSigner: ethers.Wallet,     // EOA(계정)
  sponsorSigner: ethers.Wallet,   // 가스 대납자
  targetAddress: string,          // 7702 구현(위임 대상) 컨트랙트 주소
  recipientAddress: string,       // ETH 전송 수신자

  // ETH 전송 금액(사람이 읽는 단위)
  ethAmountStr: string,

  // 수수료(ERC20)
  feeToken: string,
  feeReceiver: string,
  feeAmount: bigint,                 // 최소단위(토큰 decimals 반영) 정수
  feeTokenDecimals: number | undefined;

async function initializeSigners() {
  const env = process.env;
  const required = [
    "FIRST_PRIVATE_KEY",
    "SPONSOR_PRIVATE_KEY",
    "DELEGATION_CONTRACT_ADDRESS",
    "RECEIPENT_ADDRESS",
    "RPC_URL",
    "FEE_TOKEN_ADDRESS",
    "FEE_RECEIVER",
  ] as const;

  for (const k of required) {
    if (!env[k]) {
      console.error(`Missing env ${k}`);
      process.exit(1);
    }
  }

  provider = new ethers.JsonRpcProvider(env.RPC_URL!);
  firstSigner = new ethers.Wallet(env.FIRST_PRIVATE_KEY!, provider);
  sponsorSigner = new ethers.Wallet(env.SPONSOR_PRIVATE_KEY!, provider);

  targetAddress = env.DELEGATION_CONTRACT_ADDRESS!;
  recipientAddress = env.RECEIPENT_ADDRESS!;

  // ETH 전송 금액
  ethAmountStr = env.ETH_AMOUNT ?? "0.000005";

  // === ERC20 수수료 설정 ===
  feeToken = (env.FEE_TOKEN_ADDRESS!).toLowerCase(); // 반드시 ERC20 주소여야 함
  feeReceiver = env.FEE_RECEIVER!;
  feeTokenDecimals = env.FEE_TOKEN_DECIMALS ? Number(env.FEE_TOKEN_DECIMALS) : undefined;

  // feeAmount 우선순위: FEE_AMOUNT(최소단위) > FEE_AMOUNT_HUMAN(+decimals)
  if (env.FEE_AMOUNT) {
    feeAmount = BigInt(env.FEE_AMOUNT);
  } else {
    // 사람이 읽는 수량으로 넣을 경우(예: "1.5")
    const human = env.FEE_AMOUNT_HUMAN ?? "1";
    // 온체인에서 decimals 확인(환경변수 없으면)
    const feeT = new ethers.Contract(feeToken, erc20Abi, provider);
    const chainDec = await feeT.decimals().catch(() => 6);
    if (feeTokenDecimals === undefined) feeTokenDecimals = Number(chainDec);
    feeAmount = ethers.parseUnits(human, feeTokenDecimals);
  }

  // 로그/프리플라이트
  const [b1, b2] = await Promise.all([
    provider.getBalance(firstSigner.address),
    provider.getBalance(sponsorSigner.address),
  ]);
  console.log("First(ETH):  ", firstSigner.address, ethers.formatEther(b1));
  console.log("Sponsor(ETH):", sponsorSigner.address, ethers.formatEther(b2));

  // ERC20 수수료 토큰 정보 및 잔고
  const feeTokenC = new ethers.Contract(feeToken, erc20Abi, provider);
  const [sym, dec, feeBal] = await Promise.all([
    feeTokenC.symbol().catch(() => "FEE"),
    feeTokenC.decimals().catch(() => feeTokenDecimals ?? 6),
    feeTokenC.balanceOf(firstSigner.address).catch(() => 0n),
  ]);
  if (feeTokenDecimals === undefined) feeTokenDecimals = Number(dec);
  console.log(`FeeToken : ${sym} (dec=${feeTokenDecimals}) bal=${feeBal.toString()}`);
  if (feeBal < feeAmount) {
    throw new Error(`Insufficient fee token balance: have=${feeBal.toString()} need=${feeAmount.toString()}`);
  }

  // ETH 전송 잔고 검사(계정의 ETH 잔고에서 value가 나감)
  const needEth = ethers.parseEther(ethAmountStr);
  if (b1 < needEth) {
    throw new Error(`Insufficient ETH balance: have=${ethers.formatEther(b1)} need=${ethAmountStr}`);
  }
}

function packCallsHash(calls: CallInput[]): string {
  let encoded = "0x";
  for (const [to, value, data] of calls) {
    encoded += ethers
      .solidityPacked(["address", "uint256", "bytes"], [to, value, data])
      .slice(2);
  }
  return ethers.keccak256(encoded);
}

// 컨트랙트용 nonce(slot0) — 배치 서명에 사용
async function getContractNonce(account: string, contract: ethers.Contract): Promise<bigint> {
  try {
    const n: bigint = await contract.nonce();
    return n;
  } catch {
    const raw = await provider.getStorage(account, 0n).catch(() => null);
    return BigInt(raw ?? "0x0");
  }
}

// Authorization nonce — EOA tx nonce 규칙
async function getAuthorizationNonce(): Promise<number> {
  const txNonce = await provider.getTransactionCount(firstSigner.address, "latest");
  const isSponsored =
    sponsorSigner.address.toLowerCase() !== firstSigner.address.toLowerCase();
  return isSponsored ? txNonce : txNonce + 1;
}

async function createAuthorization(authNonce: number) {
  const { chainId } = await provider.getNetwork();
  return await firstSigner.authorize({
    address: targetAddress,       // 위임(구현) 주소
    nonce: authNonce,             // ✅ EOA tx nonce
    chainId: Number(chainId),
  });
}

// digest = keccak256(abi.encode(callsHash, fee.token, fee.amount, fee.receiver, contractNonce, deadline))
async function createSignature(
  calls: CallInput[],
  contractNonce: bigint,
  deadline: bigint,
  feeTokenAddr: string,
  feeAmount_: bigint,
  feeReceiverAddr: string
) {
  const callsHash = packCallsHash(calls);
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "uint256", "address", "uint256", "uint256"],
      [callsHash, feeTokenAddr, feeAmount_, feeReceiverAddr, contractNonce, deadline]
    )
  );
  const sig = await firstSigner.signMessage(ethers.getBytes(digest)); // personal_sign

  // 로컬 복구 검증(디버깅용)
  const recovered = ethers.verifyMessage(ethers.getBytes(digest), sig);
  if (recovered.toLowerCase() !== firstSigner.address.toLowerCase()) {
    throw new Error(
      `Local recover mismatch: recovered=${recovered}, expected=${firstSigner.address}`
    );
  }
  return sig;
}

async function sendSponsoredTransaction() {
  console.log("\n=== SPONSORED ETH TRANSFER with ERC20 FEE ===");

  const delegated = new ethers.Contract(firstSigner.address, rewardyAbi, sponsorSigner);

  // ===== 1) ETH 전송 calls 구성 =====
  const ethValue = ethers.parseEther(ethAmountStr);
  const calls: CallInput[] = [[recipientAddress, ethValue, "0x"]];
  console.log(`Transfer ETH: ${ethAmountStr} → ${recipientAddress}`);

  // ===== 2) 수수료(Fee) — 반드시 ERC20이어야 함 =====
  if (feeToken === ethers.ZeroAddress) {
    throw new Error("feeToken must be an ERC20 address (not ZeroAddress) for this script.");
  }
  const fee = {
    token: feeToken,
    amount: feeAmount,
    receiver: feeReceiver,
  };

  // ===== 3) Nonces & Deadline =====
  const contractNonce = await getContractNonce(firstSigner.address, delegated);  // 배치 서명용
  const authNonce = await getAuthorizationNonce();                               // Authorization(EOA tx nonce)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);                 // +10분

  console.log("contractNonce(slot0):", contractNonce.toString());
  console.log("authorizationNonce(EOA tx nonce):", authNonce);

  // ===== 4) Authorization & Signature =====
  const auth = await createAuthorization(authNonce);
  const signature = await createSignature(
    calls,
    contractNonce,
    deadline,
    fee.token,
    fee.amount,
    fee.receiver
  );

  // ===== 5) 실행(type:4, authorizationList 포함) =====
  const tx = await delegated["executeWithFee"](
    calls,
    fee,
    deadline,
    signature,
    {
      type: 4,                    // 7702
      authorizationList: [auth],  // EOA → 구현 위임
    }
  );

  console.log("tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("done:", receipt.status);
}

async function run() {
  await initializeSigners();
  await sendSponsoredTransaction();
}
run().catch(console.error);
