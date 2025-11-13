// coin_transfer.ts
import "dotenv/config";
import { ethers, Wallet } from "ethers";

// ===== Minimal ABI (Rewardy) =====
const rewardyAbi = [
  "function nonce() view returns (uint256)",
  "function executeWithAuthorization((address to,uint256 value,bytes data)[] calls,uint256 deadline,bytes signature) payable",
  "function executeWithFee((address to,uint256 value,bytes data)[] calls,(address token,uint256 amount,address receiver) fee,uint256 deadline,bytes signature) payable",
  "event BatchExecuted(uint256 indexed nonce, uint256 callCount, bytes32 callsHash)",
  "event FeeCharged(address indexed token, address indexed to, uint256 amount)",
] as const;

type CallInput = [string, bigint, string];

let provider: ethers.JsonRpcProvider,
  firstSigner: ethers.Wallet,
  sponsorSigner: ethers.Wallet,
  targetAddress: string,
  recipientAddress: string;

async function initializeSigners() {
  const {
    FIRST_PRIVATE_KEY,
    SPONSOR_PRIVATE_KEY,
    DELEGATION_CONTRACT_ADDRESS,
    RECEIPENT_ADDRESS,
    RPC_URL,
  } = process.env;

  if (
    !FIRST_PRIVATE_KEY ||
    !SPONSOR_PRIVATE_KEY ||
    !DELEGATION_CONTRACT_ADDRESS ||
    !RECEIPENT_ADDRESS ||
    !RPC_URL
  ) {
    console.error("Please set your environmental variables in .env file.");
    process.exit(1);
  }

  provider = new ethers.JsonRpcProvider(RPC_URL);
  firstSigner = new ethers.Wallet(FIRST_PRIVATE_KEY, provider);
  sponsorSigner = new ethers.Wallet(SPONSOR_PRIVATE_KEY, provider);

  targetAddress = DELEGATION_CONTRACT_ADDRESS!;
  recipientAddress = RECEIPENT_ADDRESS!;

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
  const auth = await firstSigner.authorize({
    address: targetAddress,
    nonce: authNonce, // ✅ EOA tx nonce
    chainId: Number(chainId),
  });
  return auth;
}

/**
 * 컨트랙트 서명 규격(RewardyContract):
 * digest = keccak256(abi.encode(
 *   callsHash, fee.token(=0), fee.amount(=0), fee.receiver(=0), contractNonce, deadline
 * ))
 * 서명은 personal_sign (toEthSignedMessageHash) 경로
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
      [callsHash, ethers.ZeroAddress, 0n, ethers.ZeroAddress, contractNonce, deadline]
    )
  );

  const sig = await firstSigner.signMessage(ethers.getBytes(digest)); // personal_sign

  // 로컬 검증(디버그): signer 복구가 firstSigner와 동일해야 함
  const recovered = ethers.verifyMessage(ethers.getBytes(digest), sig);
  if (recovered.toLowerCase() !== firstSigner.address.toLowerCase()) {
    throw new Error(
      `Local recover mismatch: recovered=${recovered}, expected=${firstSigner.address}`
    );
  }
  return sig;
}

async function sendSponsoredTransaction() {
  console.log("\n=== SPONSORED ETH TRANSFER (no fee) ===");

  const delegated = new ethers.Contract(
    firstSigner.address,
    rewardyAbi,
    sponsorSigner
  );

  // 예: ETH 0.000003 전송
  const calls: CallInput[] = [
    [recipientAddress, ethers.parseEther("0.000003"), "0x"],
  ];

  // (A) 컨트랙트용 nonce (slot0)
  const contractNonce = await getContractNonce(firstSigner.address, delegated);

  // (B) Authorization용 nonce (EOA tx nonce 규칙)
  const authNonce = await getAuthorizationNonce();

  console.log("contractNonce(slot0):", contractNonce.toString());
  console.log("authorizationNonce(EOA tx nonce):", authNonce);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600); // +10분

  const auth = await createAuthorization(authNonce);
  const signature = await createSignature(calls, contractNonce, deadline);

  // 수수료 없는 경로: executeWithAuthorization 사용
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
