// account.ts
import { publicClient } from "./client";
import { toSimple7702SmartAccount } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";

export function getOwnerFromEnv() {
  const pk = process.env.PRIVATE_KEY as `0x${string}`;
  if (!pk) throw new Error("PRIVATE_KEY is required");
  return privateKeyToAccount(pk);
}

function getImplementationFromEnv() {
  const impl = process.env.IMPLEMENTATION_ADDRESS as `0x${string}` | undefined;
  if (!impl) throw new Error("IMPLEMENTATION_ADDRESS is required");
  return impl;
}

// 일반 전송/스폰서 공통: 원하는 구현주소를 주입해서 반환
export async function getSmartAccount(opts?: { implementation?: `0x${string}` }) {
  const owner = getOwnerFromEnv();
  const implementation = (opts?.implementation ?? getImplementationFromEnv()) as `0x${string}`;
  const sa = await toSimple7702SmartAccount({
    client: publicClient,
    owner,
    implementation,             // ✅ 여기서 덮어쓰기
  });
  return sa;
}

// 필요하면 아래 헬퍼도 동일하게 주입
export async function getSmartAccountForSend() {
  return getSmartAccount();
}
export async function getSmartAccountForSponsor() {
  return getSmartAccount();
}
