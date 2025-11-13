// src/shared/helpers.ts
import { http, encodeFunctionData, parseEther, parseUnits } from "viem";
import { createPaymasterClient } from "viem/account-abstraction";
import { commonClient, publicClient, chain } from "../client";

export type Hex = `0x${string}`;
export const ENTRYPOINT_V08: Hex = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"; // 사용자 코드와 동일 값 유지

export function envOrThrow(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env ${key}`);
  return v;
}

export function bump(x?: bigint, pct: bigint = 150n) {
  return x ? (x * pct) / 100n : undefined;
}

export async function getEntryPointAddress(): Promise<Hex> {
  const eps = (await commonClient.request({ method: "eth_supportedEntryPoints", params: [] })) as Hex[];
  if (!eps?.length) throw new Error("No supported EntryPoints from bundler");
  return eps[0];
}

// export async function getEntryPointAddress(): Promise<`0x${string}`> {
//   return ENTRYPOINT_V08; // 캐논으로 고정
// }

export async function waitOrDebug(hash: Hex) {
  try {
    return await commonClient.waitForUserOperationReceipt({ hash, timeout: 180_000, pollingInterval: 3_000 });
  } catch (e) {
    console.warn("⏱ timed out. debugging…");
    try { console.log("eth_getUserOperationByHash =", await commonClient.request({ method: "eth_getUserOperationByHash", params: [hash] })); } catch {}
    try { console.log("supported EntryPoints      =", await commonClient.request({ method: "eth_supportedEntryPoints", params: [] })); } catch {}
    throw e;
  }
}

export async function getFeesL2Safe() {
  try {
    const f = await publicClient.estimateFeesPerGas();
    if (f.maxFeePerGas && f.maxPriorityFeePerGas) {
      return {
        maxFeePerGas: bump(f.maxFeePerGas)!,
        maxPriorityFeePerGas: bump(f.maxPriorityFeePerGas)!,
      };
    }
  } catch {}
  const gp = await publicClient.getGasPrice();
  return { maxFeePerGas: bump(gp)!, maxPriorityFeePerGas: bump(gp)! };
}

export function toWeiFromEnv(humanKey: string, decimalsKey: string, fallbackHuman = "1", fallbackDec = "6") {
  const human = process.env[humanKey] ?? fallbackHuman;
  const dec = Number(process.env[decimalsKey] ?? fallbackDec);
  return parseUnits(human, dec);
}

export function createPaymaster(url: string) {
  return createPaymasterClient({ transport: http(url) });
}

export async function sanityLog() {
  const [chainId, block] = await Promise.all([publicClient.getChainId(), publicClient.getBlockNumber()]);
  console.log("[rpc]", { chainId, block: block.toString(), chain: chain.name });
}
