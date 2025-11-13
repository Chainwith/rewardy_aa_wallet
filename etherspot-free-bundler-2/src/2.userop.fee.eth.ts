// === 최종 안정 버전 ===
import "dotenv/config";
import {
  http,
  parseEther,
  encodeFunctionData,
  createWalletClient,
  getAddress,
  formatEther,
  Hex,
  decodeAbiParameters,
} from "viem";
import { createPaymasterClient } from "viem/account-abstraction";
import { commonClient, publicClient, chain } from "./client";
import { getSmartAccount, getOwnerFromEnv } from "./account";

type HexStr = `0x${string}`;
const ENTRYPOINT_V08: HexStr = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";

const rewardyAbi = [
  { type: "function", name: "selectFeeToken", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }], outputs: [] },
  { type: "function", name: "getFeeConfig", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "bool" }, { type: "uint256" }, { type: "bool" }] },
  { type: "function", name: "getFeeTokens", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "feeReceiver", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeRequired", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "entryPoint", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "altEntryPoint", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

function envOrThrow(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env ${key}`);
  return v;
}
function bump(x?: bigint, pct: bigint = 150n) {
  return x ? (x * pct) / 100n : undefined;
}
async function getEntryPointAddress(): Promise<HexStr> {
  const eps = (await commonClient.request({ method: "eth_supportedEntryPoints", params: [] })) as HexStr[];
  if (!eps?.length) throw new Error("No supported EntryPoints from bundler");
  return eps[0];
}
async function waitOrDebug(hash: HexStr) {
  try {
    return await commonClient.waitForUserOperationReceipt({ hash, timeout: 180_000, pollingInterval: 3_000 });
  } catch (e) {
    console.warn("⏱  waitForUserOperationReceipt timeout. Debugging…");
    try { console.log("• eth_getUserOperationByHash =", await commonClient.request({ method: "eth_getUserOperationByHash", params: [hash] })); } catch {}
    try { console.log("• eth_supportedEntryPoints   =", await commonClient.request({ method: "eth_supportedEntryPoints", params: [] })); } catch {}
    throw e;
  }
}

/** auth-list를 얹은 eth_call 로 readContract와 동일한 디코딩을 얻는 헬퍼 */
async function authRead<T>(
  accountAddr: HexStr,
  fn: (typeof rewardyAbi)[number]["name"],
  args: any[],
  authorization: any
): Promise<T> {
  const data = encodeFunctionData({ abi: rewardyAbi, functionName: fn as any, args });
  const res = await publicClient.call({ to: accountAddr, data: data as Hex, authorizationList: [authorization] });
  if (!res.data || res.data === "0x") throw new Error(`authRead(${String(fn)}) returned 0x`);
  // viem의 decodeAbiParameters로 디코드
  // outputs는 ABI에서 뽑아오기 귀찮으니 함수별로 스위치
  if (fn === "getFeeConfig") {
    const [exists, amount, enabled] = decodeAbiParameters(
      [{ type: "bool" }, { type: "uint256" }, { type: "bool" }],
      res.data
    );
    return [exists, amount, enabled] as unknown as T;
  } else if (fn === "feeReceiver" || fn === "entryPoint" || fn === "altEntryPoint") {
    const [addr] = decodeAbiParameters([{ type: "address" }], res.data);
    return addr as unknown as T;
  } else if (fn === "feeRequired") {
    const [b] = decodeAbiParameters([{ type: "bool" }], res.data);
    return b as unknown as T;
  } else if (fn === "getFeeTokens") {
    const [arr] = decodeAbiParameters([{ type: "address[]" }], res.data);
    return arr as unknown as T;
  }
  throw new Error(`authRead(): unsupported fn ${String(fn)}`);
}

async function main() {
  // ===== ENV =====
  const TO = getAddress(envOrThrow("CASE2_TO")) as HexStr;
  const VALUE_ETH = process.env.CASE2_VALUE_ETH ?? "0.00002";
  const FEE_TOKEN = getAddress(envOrThrow("CASE2_FEE_TOKEN")) as HexStr; // 등록된 ERC20 주소
  const PAYMASTER_URL = envOrThrow("PAYMASTER_URL");

  // ===== Init =====
  const paymaster = createPaymasterClient({ transport: http(PAYMASTER_URL) });
  const sa = await getSmartAccount();
  console.log("================================================================");
  console.log("[cfg] chain          :", chain.id, chain.name);
  console.log("[cfg] smartAccount   :", sa.address);
  console.log("[cfg] to             :", TO);
  console.log("[cfg] send value     :", VALUE_ETH, "ETH");
  console.log("[cfg] fee token      :", FEE_TOKEN);
  console.log("================================================================");

  // ===== (A) 7702 위임 상태 확인/서명(읽기에도 쓸 auth 준비) =====
  const code = await publicClient.getCode({ address: sa.address });
  const impl = sa.authorization.address as HexStr;
  const expectedPrefix = (`0xef0100${impl.toLowerCase().slice(2)}`) as HexStr;

  let authorization: any | undefined;
  if (code !== expectedPrefix) {
    console.log("⚠️  Implementation not delegated yet. Signing 7702 authorization…");
    const owner = getOwnerFromEnv();
    const chainId = await publicClient.getChainId();
    const txNonce = await publicClient.getTransactionCount({ address: owner.address, blockTag: "latest" });
    const walletClient = createWalletClient({ account: owner, chain, transport: http(process.env.RPC_URL!) });
    authorization = await walletClient.signAuthorization({ address: impl, chainId, nonce: txNonce });
    console.log("✅  Signed 7702 authorization (will be used for reads & UserOp)");
  } else {
    console.log("✅  Already delegated to implementation (authorization may be skipped).");
  }

  // ===== (B) EP 정합성 =====
  const bundlerEP = await getEntryPointAddress();

  // entry/alt는 기존 구현에도 있을 수 있으니 평범히 읽고, 실패 시 auth-read
  let accEP: HexStr, accAltEP: HexStr;
  try {
    accEP = await publicClient.readContract({ address: sa.address, abi: rewardyAbi, functionName: "entryPoint" }) as HexStr;
    accAltEP = await publicClient.readContract({ address: sa.address, abi: rewardyAbi, functionName: "altEntryPoint" }) as HexStr;
  } catch {
    if (!authorization) throw new Error("entry/alt read failed and no authorization available");
    accEP = await authRead<HexStr>(sa.address as HexStr, "entryPoint", [], authorization);
    accAltEP = await authRead<HexStr>(sa.address as HexStr, "altEntryPoint", [], authorization);
  }
  console.log("----------------------------------------------------------------");
  console.log("[EP] canonical(v0.8) :", ENTRYPOINT_V08);
  console.log("[EP] bundler uses    :", bundlerEP);
  console.log("[EP] account.entry   :", accEP);
  console.log("[EP] account.alt     :", accAltEP);
  if (bundlerEP.toLowerCase() !== accEP.toLowerCase() && bundlerEP.toLowerCase() !== (accAltEP?.toLowerCase() ?? "")) {
    console.warn("⚠️  Bundler EP != account.entry/alt. Consider deploying with matching ALT_ENTRY_POINT.");
  }

  // ===== (C) 사전 점검 (모두 auth-read로 시도) =====
  const [feeReceiver, feeRequired] = authorization
    ? await Promise.all([
        authRead<HexStr>(sa.address as HexStr, "feeReceiver", [], authorization),
        authRead<boolean>(sa.address as HexStr, "feeRequired", [], authorization),
      ])
    : await Promise.all([
        publicClient.readContract({ address: sa.address, abi: rewardyAbi, functionName: "feeReceiver" }) as Promise<HexStr>,
        publicClient.readContract({ address: sa.address, abi: rewardyAbi, functionName: "feeRequired" }) as Promise<boolean>,
      ]);

  // getFeeConfig는 새 구현 전용이므로 무조건 auth-read 권장
  const [exists, amount, enabled] = await authRead<[boolean, bigint, boolean]>(
    sa.address as HexStr,
    "getFeeConfig",
    [FEE_TOKEN],
    authorization ?? (() => { throw new Error("Need authorization to read getFeeConfig on legacy impl"); })()
  );

  const [ethBal, feeTokenBal, toCode] = await Promise.all([
    publicClient.getBalance({ address: sa.address }),
    publicClient.readContract({ address: FEE_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [sa.address] }) as Promise<bigint>,
    publicClient.getCode({ address: TO }),
  ]);

  console.log("----------------------------------------------------------------");
  console.log("[precheck] feeRequired      :", feeRequired);
  console.log("[precheck] feeReceiver      :", feeReceiver);
  console.log("[precheck] getFeeConfig()   :", `{ exists: ${exists}, amount: ${amount.toString()}, enabled: ${enabled} }`);
  console.log("[precheck] feeToken balance :", feeTokenBal.toString());
  console.log("[precheck] SA ETH balance   :", formatEther(ethBal), "ETH");
  console.log("[precheck] recipient code   :", toCode === "0x" ? "EOA (no code)" : "CONTRACT (has code)");

  if (feeRequired) {
    if (!exists || !enabled) throw new Error("Fee token is not configured/enabled on contract.");
    if (feeTokenBal < amount) throw new Error(`Insufficient fee token balance. Need ${amount.toString()}.`);
    if (feeReceiver === `0x0000000000000000000000000000000000000000`) throw new Error("feeReceiver is zero address.");
  }

  // ETH 전송 값은 계정 잔고에서 나감(가스는 페이마스터)
  const valueWei = parseEther(VALUE_ETH);
  if (valueWei > 0n && ethBal < valueWei) {
    throw new Error(`Insufficient ETH balance on smart account. Need >= ${VALUE_ETH} ETH (current: ${formatEther(ethBal)}).`);
  }

  // ===== (D) gas =====
  const fees = await publicClient.estimateFeesPerGas();
  const maxPriorityFeePerGas = bump(fees.maxPriorityFeePerGas ?? 2_000_000_000n)!;
  const maxFeePerGas = bump(fees.maxFeePerGas ?? (fees.baseFeePerGas ?? 2_000_000_000n) + (fees.maxPriorityFeePerGas ?? 2_000_000_000n))!;

  // ===== (E) Calls: [ self-call selectFeeToken, external ETH transfer ] =====
  const selectFeeCall = {
    to: sa.address as HexStr,
    value: 0n,
    data: encodeFunctionData({ abi: rewardyAbi, functionName: "selectFeeToken", args: [FEE_TOKEN] }) as HexStr,
  };
  const ethCall = { to: TO, value: valueWei, data: "0x" as HexStr };
  const calls = [selectFeeCall, ethCall];

  console.log("----------------------------------------------------------------");
  console.log("[build] calls[0]=selectFeeToken(", FEE_TOKEN, ")");
  console.log("[build] calls[1]=ETH transfer to", TO, "value", VALUE_ETH, "ETH");

  // ===== (F) Estimate & Send =====
  const gasBare = await commonClient.estimateUserOperationGas({
    account: sa, authorization, calls, entryPoint: bundlerEP, maxFeePerGas, maxPriorityFeePerGas,
  });
  console.log("[gas] bare =", gasBare);

  const callGasLimit = bump(gasBare.callGasLimit, 130n);
  const verificationGasLimit = bump(gasBare.verificationGasLimit, 130n);
  const preVerificationGas = bump(gasBare.preVerificationGas, 130n);
  console.log("[gas] bumped =", {
    callGasLimit: callGasLimit?.toString(),
    verificationGasLimit: verificationGasLimit?.toString(),
    preVerificationGas: preVerificationGas?.toString(),
    maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString()
  });

  const uoHash = await commonClient.sendUserOperation({
    account: sa, authorization, calls, entryPoint: bundlerEP,
    callGasLimit, verificationGasLimit, preVerificationGas, maxFeePerGas, maxPriorityFeePerGas,
    paymaster,
  });
  console.log("================================================================");
  console.log("userOpHash =", uoHash);
  const receipt = await waitOrDebug(uoHash);
  console.log("UserOp receipt =", receipt);
  console.log("================================================================");
}

main().catch((e) => {
  console.error("❌  FAILED:", e);
  process.exit(1);
});
