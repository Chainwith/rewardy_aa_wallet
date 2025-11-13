// client.ts
import "dotenv/config";
import {
  createFreeBundler,
  getBundlerConfig, // 선택 사용: 체인별 기본 번들러 URL 얻기
} from "@etherspot/free-bundler";
import { createPublicClient, http, publicActions, walletActions } from "viem";
import type { Chain } from "viem";
import {
  mainnet,
  sepolia,
  optimism,
  arbitrum,
  base,
  polygon,
  linea,
  scroll,
  baseSepolia,
  arbitrumSepolia,
  optimismSepolia,
  polygonAmoy
} from "viem/chains";

/**
 * CHAIN 환경변수로 체인을 선택 (기본: sepolia)
 * 필요 체인만 map에 추가해서 사용하세요.
 */
function resolveChain(): Chain {
  const byName = (process.env.CHAIN || "sepolia");
  const map: Record<string, Chain> = {
    mainnet,
    sepolia,
    baseSepolia,
    arbitrumSepolia,
    optimismSepolia,
    polygonAmoy,
    optimism,
    arbitrum,
    base,
    polygon,
    linea,
    scroll,
  };
  return map[byName] ?? sepolia;
}

export const chain = resolveChain();

/**
 * free-bundler 클라이언트 생성
 * - transport는 viem의 http()가 아니라 옵션 객체이므로 생략(기본값 사용)
 * - 필요하면 getBundlerConfig(chain.id).url로 번들러 URL을 명시적으로 지정할 수 있음
 */
// let bundlerUrl: string | undefined;
// try {
//   const cfg = getBundlerConfig?.(chain.id); // { chainId, name, url, isTestnet }
//   if (cfg?.url) bundlerUrl = cfg.url;
// } catch {
//   // SDK 버전/환경에 따라 유틸이 없을 수 있음 → 생략 가능
// }
// client.ts
const bundlerUrl = process.env.BUNDLER_URL!;
const rpcUrl = process.env.RPC_URL!;

if (!rpcUrl) throw new Error("RPC_URL is missing (must be a full node RPC, not Pimlico).");
if (/pimlico\.io/i.test(rpcUrl)) {
  throw new Error("RPC_URL points to Pimlico. Set RPC_URL to a full node RPC (Alchemy/Infura/etc.).");
}

// (optionally) log once for sanity
console.log("[cfg] bundler:", bundlerUrl);
console.log("[cfg] rpc:", rpcUrl);

export const commonClient = createFreeBundler({
  chain,
  ...(bundlerUrl ? { bundlerUrl } : {}),
})
  .extend(publicActions)
  .extend(walletActions);

// L1 public client for normal JSON-RPC
export const publicClient = createPublicClient({
  chain,
  transport: http(rpcUrl!),  // <- set RPC_URL in .env
});
