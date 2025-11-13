// coin_transfer_with_fee.ts
import "dotenv/config";
import { ethers } from "ethers";

const rewardyAbi = [
  "function nonce() view returns (uint256)",
  "function executeWithFee((address to,uint256 value,bytes data)[] calls,(address token,uint256 amount,address receiver) fee,uint256 deadline,bytes signature) payable",
] as const;

const erc20Abi = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) external returns (bool)",
] as const;

type CallInput = [string, bigint, string];

let provider: ethers.JsonRpcProvider,
  firstSigner: ethers.Wallet,     // EOA(계정)
  sponsorSigner: ethers.Wallet,   // 가스 대납자
  targetAddress: string,          // 7702 구현(위임 대상) 컨트랙트 주소
  recipientAddress: string,       // 전송 수신자

  // 전송 토큰 (ZeroAddress면 ETH 전송)
  tokenAddress: string,
  tokenDecimals: number,
  erc20AmountStr: string,         // "10" 같이 사람이 읽는 단위

  // 수수료 파라미터
  feeToken: string,               // ZeroAddress = ETH fee
  feeReceiver: string,
  feeAmount: bigint,              // 최소단위(wei or token decimals) 정수값
  feeTokenDecimals: number | undefined; // ← 명시적 타입 지정


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
    "FEE_AMOUNT",
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

  // ===== 전송 자산 설정 =====
  tokenAddress = (env.TOKEN_ADDRESS ?? ethers.ZeroAddress).toLowerCase();
  erc20AmountStr = env.ERC20_AMOUNT ?? "10"; // 기본 10 토큰
  tokenDecimals = Number(env.TOKEN_DECIMALS ?? "6"); // 없으면 6으로 가정

  // ===== 수수료 설정 =====
  feeToken = (env.FEE_TOKEN_ADDRESS!).toLowerCase();
  feeReceiver = env.FEE_RECEIVER!;
  // FEE_AMOUNT 는 최소단위(wei 또는 token decimals)로 입력했다고 가정
  // 만약 사람이 읽는 단위를 쓰고 싶으면 FEE_TOKEN_DECIMALS 와 FEE_AMOUNT_HUMAN 을 사용하세요.
  feeAmount = BigInt(env.FEE_AMOUNT!);
  feeTokenDecimals = env.FEE_TOKEN_DECIMALS ? Number(env.FEE_TOKEN_DECIMALS) : undefined;

  // 온체인 메타/잔고 로그
  const [b1, b2] = await Promise.all([
    provider.getBalance(firstSigner.address),
    provider.getBalance(sponsorSigner.address),
  ]);
  console.log("First(ETH):  ", firstSigner.address, ethers.formatEther(b1));
  console.log("Sponsor(ETH):", sponsorSigner.address, ethers.formatEther(b2));

  if (tokenAddress !== ethers.ZeroAddress) {
    const token = new ethers.Contract(tokenAddress, erc20Abi, provider);
    const [sym, chainDec] = await Promise.all([
      token.symbol().catch(() => "ERC20"),
      token.decimals().catch(() => tokenDecimals),
    ]);
    // 환경에 TOKEN_DECIMALS가 없으면 온체인 값으로 보정
    if (!process.env.TOKEN_DECIMALS) tokenDecimals = Number(chainDec);
    console.log(`SendToken: ${sym} (dec=${tokenDecimals})`);
  }

  if (feeToken !== ethers.ZeroAddress) {
    const feeT = new ethers.Contract(feeToken, erc20Abi, provider);
    const [sym, chainDec] = await Promise.all([
      feeT.symbol().catch(() => "FEE"),
      feeT.decimals().catch(() => feeTokenDecimals ?? 6),
    ]);
    if (!feeTokenDecimals) feeTokenDecimals = Number(chainDec);
    console.log(`FeeToken : ${sym} (dec=${feeTokenDecimals})`);
  } else {
    console.log(`FeeToken : ETH (wei=${feeAmount.toString()})`);
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
  const isSponsored = sponsorSigner.address.toLowerCase() !== firstSigner.address.toLowerCase();
  return isSponsored ? txNonce : txNonce + 1;
}

async function createAuthorization(authNonce: number) {
  const { chainId } = await provider.getNetwork();
  return await firstSigner.authorize({
    address: targetAddress,             // 위임(구현) 주소
    nonce: authNonce,                   // ✅ EOA tx nonce
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
    throw new Error(`Local recover mismatch: recovered=${recovered}, expected=${firstSigner.address}`);
  }
  return sig;
}

async function sendSponsoredTransaction() {
  console.log("\n=== SPONSORED TRANSFER with FEE ===");

  const delegated = new ethers.Contract(firstSigner.address, rewardyAbi, sponsorSigner);

  // ===== 1) 전송 calls 구성 =====
  const calls: CallInput[] = [];
  if (tokenAddress === ethers.ZeroAddress) {
    // ETH 전송
    const ethAmountStr = process.env.ETH_AMOUNT ?? "0.000005";
    const ethValue = ethers.parseEther(ethAmountStr);
    calls.push([recipientAddress, ethValue, "0x"]);
    console.log(`Transfer ETH: ${ethAmountStr} → ${recipientAddress}`);
  } else {
    // ERC20 전송
    const tokenIface = new ethers.Interface(erc20Abi);
    const amount = ethers.parseUnits(erc20AmountStr, tokenDecimals);
    const data = tokenIface.encodeFunctionData("transfer", [recipientAddress, amount]);
    calls.push([tokenAddress, 0n, data]);
    console.log(`Transfer ERC20: ${erc20AmountStr} (dec=${tokenDecimals}) → ${recipientAddress}`);
  }

  // ===== 2) 수수료(Fee) =====
  // - feeAmount는 이미 최소단위 정수라고 가정(wei or token decimals)
  // - 사람이 읽는 단위 사용을 원하면 FEE_AMOUNT_HUMAN + FEE_TOKEN_DECIMALS로 parseUnits하세요.
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
      type: 4,
      authorizationList: [auth],
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
