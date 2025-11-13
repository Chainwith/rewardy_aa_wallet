// 7702 + Etherspot Free-Bundler(4337 v0.8) + ERC20 fee + ERC20 transfer

import "dotenv/config";
import {
  http,
  encodeFunctionData,
  parseUnits,
  createWalletClient,
} from "viem";
import { createPaymasterClient } from "viem/account-abstraction";
import { commonClient, publicClient, chain } from "./client";
import { getSmartAccount, getOwnerFromEnv } from "./account";

type Hex = `0x${string}`;

const ENTRYPOINT_V08: Hex = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";

const erc20Abi = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address", name: "account" }], outputs: [{ type: "uint256" }] },
] as const;

function envOrThrow(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env ${key}`);
  return v;
}
function bump(x?: bigint, pct: bigint = 150n) { return x ? (x * pct) / 100n : undefined; }

async function getEntryPointAddress(): Promise<`0x${string}`> {
  const eps = (await commonClient.request({ method: "eth_supportedEntryPoints", params: [] })) as `0x${string}`[];
  if (!eps?.length) throw new Error("No supported EntryPoints from bundler");
  return eps[0];
}
async function waitOrDebug(hash: `0x${string}`) {
  try {
    return await commonClient.waitForUserOperationReceipt({ hash, timeout: 180_000, pollingInterval: 3_000 });
  } catch (e) {
    console.warn("Timed out. Debugging…");
    try { console.log("eth_getUserOperationByHash =", await commonClient.request({ method: "eth_getUserOperationByHash", params: [hash] })); } catch {}
    try { console.log("supported EntryPoints =", await commonClient.request({ method: "eth_supportedEntryPoints", params: [] })); } catch {}
    throw e;
  }
}

async function main() {
  // ===== ENV =====
  const PAYMASTER_URL        = envOrThrow("PAYMASTER_URL");
  const PAYMASTER_CONTEXT    = process.env.PAYMASTER_CONTEXT ?? "";

  // Fee 설정
  const FEE_TOKEN_ADDRESS    = envOrThrow("FEE_TOKEN_ADDRESS") as Hex;
  const FEE_RECEIVER         = envOrThrow("FEE_RECEIVER") as Hex;
  let   FEE_AMOUNT: bigint;
  if (process.env.FEE_AMOUNT) {
    FEE_AMOUNT = BigInt(process.env.FEE_AMOUNT);
  } else {
    const human = process.env.FEE_AMOUNT_HUMAN ?? "1";
    const dec   = Number(process.env.FEE_TOKEN_DECIMALS ?? "6");
    FEE_AMOUNT  = parseUnits(human, dec);
  }

  // 전송할 ERC20 설정
  const TOKEN_ADDRESS        = envOrThrow("TOKEN_ADDRESS") as Hex;
  const TOKEN_TO             = envOrThrow("TOKEN_TO") as Hex;
  let   TOKEN_AMOUNT: bigint;
  if (process.env.TOKEN_AMOUNT) {
    TOKEN_AMOUNT = BigInt(process.env.TOKEN_AMOUNT);
  } else {
    const human = process.env.TOKEN_AMOUNT_HUMAN ?? "1";
    // 토큰 소수점 자동 조회(없으면 TOKEN_DECIMALS 사용)
    let dec = Number(process.env.TOKEN_DECIMALS ?? "0");
    if (!process.env.TOKEN_DECIMALS) {
      try { dec = await publicClient.readContract({ abi: erc20Abi, address: TOKEN_ADDRESS, functionName: "decimals" }) as number; } catch {}
    }
    TOKEN_AMOUNT = parseUnits(human, dec);
  }

  // ===== Paymaster =====
  const paymaster = createPaymasterClient({ transport: http(PAYMASTER_URL) });

  // ===== Smart Account =====
  const sa = await getSmartAccount();
  console.log("smartAccount.address =", sa.address);
  console.log('sa', sa);

  // ===== 7702 Authorization =====
  const code = await publicClient.getCode({ address: sa.address });
  const { address: impl } = sa.authorization;
  const expectedPrefix = (`0xef0100${impl.toLowerCase().slice(2)}`) as Hex;

  let authorization: any | undefined;
  if (code !== expectedPrefix) {
    const owner = getOwnerFromEnv();
    const chainId = await publicClient.getChainId();
    const txNonce = await publicClient.getTransactionCount({ address: owner.address, blockTag: "latest" });
    const walletClient = createWalletClient({ account: owner, chain, transport: http(process.env.RPC_URL!) });
    authorization = await walletClient.signAuthorization({ address: impl as Hex, chainId, nonce: txNonce });
    console.log(`Signed authorization: {address:${impl}, chainId:${chainId}, nonce:${txNonce}}`);
  } else {
    console.log("Already delegated to implementation. Skipping authorization.");
  }

  // ===== EP & gas =====
  const [chainId, block] = await Promise.all([publicClient.getChainId(), publicClient.getBlockNumber()]);
  console.log("[rpc]", { chainId, block: block.toString(), chain: chain.name });

  const entryPoint = await getEntryPointAddress();
  console.log("Bundler EntryPoint:", entryPoint);
  if (entryPoint.toLowerCase() !== ENTRYPOINT_V08.toLowerCase()) {
    console.warn(`⚠️ Bundler EP != v0.8 canonical (${ENTRYPOINT_V08}). Got: ${entryPoint}`);
  }

  const fees = await publicClient.estimateFeesPerGas();
  const base = fees.baseFeePerGas ?? 2_000_000_000n;
  const pri  = fees.maxPriorityFeePerGas ?? 2_000_000_000n;
  const maxPriorityFeePerGas = bump(pri)!;
  const maxFeePerGas         = bump(fees.maxFeePerGas ?? base + pri)!;

  // ===== Balances & sanity =====
  const [feeBal, tokenBal] = await Promise.all([
    publicClient.readContract({ abi: erc20Abi, address: FEE_TOKEN_ADDRESS, functionName: "balanceOf", args: [sa.address] }) as Promise<bigint>,
    publicClient.readContract({ abi: erc20Abi, address: TOKEN_ADDRESS, functionName: "balanceOf", args: [sa.address] }) as Promise<bigint>,
  ]);

  if (FEE_TOKEN_ADDRESS.toLowerCase() === TOKEN_ADDRESS.toLowerCase()) {
    if (tokenBal < FEE_AMOUNT + TOKEN_AMOUNT) {
      throw new Error(`Insufficient token balance (same token used for fee & transfer). need=${FEE_AMOUNT + TOKEN_AMOUNT}, have=${tokenBal}`);
    }
  } else {
    if (feeBal < FEE_AMOUNT)   throw new Error(`Insufficient fee token balance. need=${FEE_AMOUNT}, have=${feeBal}`);
    if (tokenBal < TOKEN_AMOUNT) throw new Error(`Insufficient transfer token balance. need=${TOKEN_AMOUNT}, have=${tokenBal}`);
  }

  // ===== Calls: [ fee(ERC20) -> token transfer(ERC20) ] =====
  const feeCall = {
    to: FEE_TOKEN_ADDRESS,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [FEE_RECEIVER, FEE_AMOUNT] }) as Hex,
  };
  const tokenTransferCall = {
    to: TOKEN_ADDRESS,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [TOKEN_TO, TOKEN_AMOUNT] }) as Hex,
  };
  const calls = [feeCall, tokenTransferCall];

  // ===== Estimate & Send =====
  const gasBare = await commonClient.estimateUserOperationGas({
    account: sa, authorization, calls, entryPoint, maxFeePerGas, maxPriorityFeePerGas,
  });
  const callGasLimit         = bump(gasBare.callGasLimit, 130n);
  const verificationGasLimit = bump(gasBare.verificationGasLimit, 130n);
  const preVerificationGas   = bump(gasBare.preVerificationGas, 130n);

  let paymasterContext: any | undefined;
  if (PAYMASTER_CONTEXT) {
    try { paymasterContext = JSON.parse(PAYMASTER_CONTEXT); } catch { throw new Error("PAYMASTER_CONTEXT must be valid JSON"); }
  }

  const uoHash = await commonClient.sendUserOperation({
    account: sa, authorization, calls, entryPoint,
    callGasLimit, verificationGasLimit, preVerificationGas, maxFeePerGas, maxPriorityFeePerGas,
    paymaster, paymasterContext,
  });
  console.log("userOpHash =", uoHash);

  const receipt = await waitOrDebug(uoHash);
  console.log("UserOp receipt =", receipt);
}

main().catch((e) => { console.error(e); process.exit(1); });
