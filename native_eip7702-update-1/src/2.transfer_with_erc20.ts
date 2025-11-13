// coin_transfer_with_erc20.ts
import "dotenv/config";
import { ethers, Wallet } from "ethers";

// ===== Minimal ABI (Rewardy) =====
const rewardyAbi = [
  "function nonce() view returns (uint256)",
  "function executeWithAuthorization((address to,uint256 value,bytes data)[] calls,uint256 deadline,bytes signature) payable",
  "event BatchExecuted(uint256 indexed nonce, uint256 callCount, bytes32 callsHash)",
] as const;

const erc20Abi = [
  "function transfer(address to, uint256 amount) external returns (bool)",
] as const;

type CallInput = [string, bigint, string];

let provider: ethers.JsonRpcProvider,
  firstSigner: ethers.Wallet,
  sponsorSigner: ethers.Wallet,
  targetAddress: string,
  recipientAddress: string,
  tokenAddress: string,
  tokenDecimals: number,
  erc20AmountStr: string;

async function initializeSigners() {
  const {
    FIRST_PRIVATE_KEY,
    SPONSOR_PRIVATE_KEY,
    DELEGATION_CONTRACT_ADDRESS,
    RECEIPENT_ADDRESS,
    RPC_URL,
    TOKEN_ADDRESS,
    TOKEN_DECIMALS,
    ERC20_AMOUNT, // 전송 수량(소수 아님, 문자열) — 기본 "10"
  } = process.env;

  if (
    !FIRST_PRIVATE_KEY ||
    !SPONSOR_PRIVATE_KEY ||
    !DELEGATION_CONTRACT_ADDRESS ||
    !RECEIPENT_ADDRESS ||
    !RPC_URL ||
    !TOKEN_ADDRESS
  ) {
    console.error("Please set your environmental variables in .env file.");
    process.exit(1);
  }

  provider = new ethers.JsonRpcProvider(RPC_URL);
  firstSigner = new ethers.Wallet(FIRST_PRIVATE_KEY, provider);
  sponsorSigner = new ethers.Wallet(SPONSOR_PRIVATE_KEY, provider);

  targetAddress = DELEGATION_CONTRACT_ADDRESS!;
  recipientAddress = RECEIPENT_ADDRESS!;
  tokenAddress = TOKEN_ADDRESS!;
  tokenDecimals = Number(TOKEN_DECIMALS ?? "6");
  erc20AmountStr = ERC20_AMOUNT ?? "10";

  const code = await provider.getCode(TOKEN_ADDRESS);
  console.log("has code?", code !== "0x");

  const erc20 = new ethers.Contract(
    TOKEN_ADDRESS,
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function balanceOf(address) view returns (uint256)",
    ],
    provider
  );
  const [sym, dec, bal] = await Promise.all([
    erc20.symbol(),
    erc20.decimals(),
    erc20.balanceOf(firstSigner.address),
  ]);
  console.log({ sym, dec, bal: bal.toString() });

  const [b1, b2] = await Promise.all([
    provider.getBalance(firstSigner.address),
    provider.getBalance(sponsorSigner.address),
  ]);
  console.log("First:", firstSigner.address, ethers.formatEther(b1));
  console.log("Sponsor:", sponsorSigner.address, ethers.formatEther(b2));
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

// 컨트랙트용 nonce: slot0 (view 실패 시 storage 직접 조회)
async function getContractNonce(
  account: string,
  contract: ethers.Contract
): Promise<bigint> {
  try {
    const n: bigint = await contract.nonce();
    return n;
  } catch {
    const raw = await provider.getStorage(account, 0n).catch(() => null);
    return BigInt(raw ?? "0x0");
  }
}

// Authorization용 nonce: EOA tx nonce (스폰서 전송이면 현재 tx nonce, 자체 전송이면 +1)
async function getAuthorizationNonce(): Promise<number> {
  const txNonce = await provider.getTransactionCount(
    firstSigner.address,
    "latest"
  );
  const isSponsored =
    sponsorSigner.address.toLowerCase() !== firstSigner.address.toLowerCase();
  return isSponsored ? txNonce : txNonce + 1;
}

async function createAuthorization(authNonce: number) {
  const { chainId } = await provider.getNetwork();
  return await firstSigner.authorize({
    address: targetAddress,
    nonce: authNonce, // ✅ EOA tx nonce
    chainId: Number(chainId),
  });
}

/**
 * 수수료 없음 버전 서명 규격:
 * digest = keccak256(abi.encode(
 *   callsHash, address(0), 0, address(0), contractNonce, deadline
 * ))
 */
async function createSignature(
  calls: CallInput[],
  contractNonce: bigint,
  deadline: bigint
) {
  const callsHash = packCallsHash(calls);

  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "uint256", "address", "uint256", "uint256"],
      [
        callsHash,
        ethers.ZeroAddress,
        0n,
        ethers.ZeroAddress,
        contractNonce,
        deadline,
      ]
    )
  );

  const sig = await firstSigner.signMessage(ethers.getBytes(digest)); // personal_sign
  const recovered = ethers.verifyMessage(ethers.getBytes(digest), sig);
  if (recovered.toLowerCase() !== firstSigner.address.toLowerCase()) {
    throw new Error(
      `Local recover mismatch: recovered=${recovered}, expected=${firstSigner.address}`
    );
  }
  return sig;
}

async function sendSponsoredTransaction() {
  console.log("\n=== SPONSORED ERC20 TRANSFER (no fee) ===");

  const delegated = new ethers.Contract(
    firstSigner.address,
    rewardyAbi,
    sponsorSigner
  );
  const erc20Iface = new ethers.Interface(erc20Abi);

  // 전송 데이터 구성
  const amount = ethers.parseUnits(erc20AmountStr, tokenDecimals);
  const data = erc20Iface.encodeFunctionData("transfer", [
    recipientAddress,
    amount,
  ]);

  const calls: CallInput[] = [[tokenAddress, 0n, data]];

  // (A) 컨트랙트용 nonce (slot0)
  const contractNonce = await getContractNonce(firstSigner.address, delegated);
  // (B) Authorization용 nonce (EOA tx nonce 규칙)
  const authNonce = await getAuthorizationNonce();

  console.log("contractNonce(slot0):", contractNonce.toString());
  console.log("authorizationNonce(EOA tx nonce):", authNonce);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600); // +10분

  const auth = await createAuthorization(authNonce);
  const signature = await createSignature(calls, contractNonce, deadline);

  const tx = await delegated["executeWithAuthorization"](
    calls,
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
