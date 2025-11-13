// 1.fee.config.auth.ts
import "dotenv/config";
import {
  http,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  decodeAbiParameters,
  parseUnits,
  Hex,
} from "viem";
import { walletActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain } from "./client";

/**
 * .env 예시
 * ACCOUNT_ADDRESS=0x...              // 호출 대상 주소 (7702 계정 주소 or 구현 컨트랙트 주소)
 * IMPLEMENTATION_ADDRESS=0x...       // Rewardy7702AA 구현 주소 (7702 위임용)
 * PRIVATE_KEY=0x...                  // 오너 PK (setFee* onlyOwner)
 * RPC_URL=https://...
 * SET_FEE_RECEIVER=0x...
 * SET_FEE_REQUIRED=true
 * FEE_TOKENS=0xToken1,0xToken2
 * FEE_AMOUNTS=0.2,0.5                // 사람 읽는 단위
 * FEE_DECIMALS=6                     // 모든 토큰 동일 소수자리일 때
 * FEE_ENABLEDS=true,true
 */

const rewardyAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "setFeeReceiver", stateMutability: "nonpayable", inputs: [{ name: "receiver", type: "address" }], outputs: [] },
  { type: "function", name: "setFeeRequired", stateMutability: "nonpayable", inputs: [{ name: "required_", type: "bool" }], outputs: [] },
  {
    type: "function",
    name: "batchUpsertFeeConfig",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "enableds", type: "bool[]" },
    ],
    outputs: [],
  },
  { type: "function", name: "getFeeTokens", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  {
    type: "function",
    name: "getAllFeeConfigs",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }, { type: "uint256[]" }, { type: "bool[]" }],
  },
  {
    type: "function",
    name: "getFeeConfig",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "bool" }, { type: "uint256" }, { type: "bool" }],
  },
  { type: "function", name: "feeReceiver", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeRequired", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

function env(k: string) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k}`);
  return v;
}

async function main() {
  const ACCOUNT_ADDRESS = env("ACCOUNT_ADDRESS") as `0x${string}`; // 7702 계정 주소 or 구현 컨트랙트 주소
  const IMPLEMENTATION_ADDRESS = env("IMPLEMENTATION_ADDRESS") as `0x${string}`;
  const RPC_URL = env("RPC_URL");
  const OWNER_PK = env("PRIVATE_KEY") as `0x${string}`;

  const FEE_RECEIVER = env("SET_FEE_RECEIVER") as `0x${string}`;
  const FEE_REQUIRED = env("SET_FEE_REQUIRED").toLowerCase() === "true";

  const TOKENS = env("FEE_TOKENS").split(",").map((s) => s.trim()) as `0x${string}`[];
  const AMOUNTS_HUMAN = env("FEE_AMOUNTS").split(",").map((s) => s.trim());
  const DEC = Number(env("FEE_DECIMALS"));
  const ENABLEDS = env("FEE_ENABLEDS").split(",").map((s) => s.trim().toLowerCase() === "true");

  if (TOKENS.length !== AMOUNTS_HUMAN.length || TOKENS.length !== ENABLEDS.length) {
    throw new Error("FEE_* lengths mismatch");
  }
  const AMOUNTS = AMOUNTS_HUMAN.map((h) => parseUnits(h, DEC));

  // Clients
  const owner = privateKeyToAccount(OWNER_PK);
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account: owner, chain, transport: http(RPC_URL) }).extend(walletActions);

  // 디버그: 대상 주소에 코드 존재 여부
  const codeAtTarget = await publicClient.getCode({ address: ACCOUNT_ADDRESS });
  console.log("[code at ACCOUNT_ADDRESS]", codeAtTarget === "0x" ? "EOA (no code)" : "CONTRACT (has code)");

  // 공통: authorization 생성 헬퍼 (각 호출마다 고유 nonce)
  const chainId = await publicClient.getChainId();
  // 'pending' 기준으로 가져오고, 각 호출마다 +i (권장)
  let authBaseNonce = await publicClient.getTransactionCount({
    address: owner.address,
    blockTag: "pending",
  });

  const signAuth = async (delta: number) => {
    const auth = await walletClient.signAuthorization({
      address: IMPLEMENTATION_ADDRESS as Hex,
      chainId,
      nonce: authBaseNonce + delta,
    });
    return auth;
  };

  // write + receipt 대기 공통 래퍼
  const writeWithAuth = async <
    FN extends (typeof rewardyAbi)[number]["name"],
    ARGS extends any[]
  >(fn: FN, args: ARGS, authNonceDelta: number) => {
    const auth = await signAuth(authNonceDelta);
    const hash = await walletClient.writeContract({
      address: ACCOUNT_ADDRESS,
      abi: rewardyAbi,
      functionName: fn,
      args,
      authorizationList: [auth],
    });
    console.log(`${String(fn)} tx:`, hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`${String(fn)} receipt status:`, receipt.status);
  };

  // ====== 1) setFeeReceiver (auth nonce: +0) ======
  await writeWithAuth("setFeeReceiver", [FEE_RECEIVER], 0);

  // ====== 2) setFeeRequired (auth nonce: +1) ======
  await writeWithAuth("setFeeRequired", [FEE_REQUIRED], 1);

  // ====== 3) batchUpsertFeeConfig (auth nonce: +2) ======
  await writeWithAuth("batchUpsertFeeConfig", [TOKENS, AMOUNTS, ENABLEDS], 2);

  // ========== READ ==========
  // 1차: 일반 readContract (대상 주소가 컨트랙트면 정상 동작)
  // 2차: 대상이 EOA라서 0x가 오면 auth + eth_call로 폴백
  async function safeRead<T>(fn: any, outputs: any, args: any[] = []) {
    try {
      const res = await publicClient.readContract({
        address: ACCOUNT_ADDRESS,
        abi: rewardyAbi,
        functionName: fn,
        args,
      });
      return res as T;
    } catch (e: any) {
      // 폴백: auth + eth_call
      const data = encodeFunctionData({ abi: rewardyAbi, functionName: fn, args });
      const auth = await signAuth(99); // read는 임의 delta 사용 (트랜잭션 아님)
      const callRes = await publicClient.call({
        to: ACCOUNT_ADDRESS,
        data,
        authorizationList: [auth],
      });
      if (!callRes.data) throw new Error(`call(${String(fn)}) returned 0x`);
      const decoded = decodeAbiParameters(outputs, callRes.data);
      // 단일 리턴인 경우 편의 반환
      return (decoded.length === 1 ? decoded[0] : decoded) as T;
    }
  }

  const tokens = await safeRead<`0x${string}`[]>("getFeeTokens", [{ type: "address[]" }]);
  console.log("getFeeTokens:", tokens);

  const [allTokens, amounts, enableds] = (await safeRead<[`0x${string}`[], bigint[], boolean[]]>(
    "getAllFeeConfigs",
    [{ type: "address[]" }, { type: "uint256[]" }, { type: "bool[]" }]
  )) as any;
  console.log("getAllFeeConfigs.tokens:", allTokens);
  console.log("getAllFeeConfigs.amounts:", (amounts as bigint[]).map((x) => x.toString()));
  console.log("getAllFeeConfigs.enableds:", enableds);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
