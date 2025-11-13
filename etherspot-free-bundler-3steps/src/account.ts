// account.ts
import { publicClient } from "./client";
import {
  toSimple7702SmartAccount,
  toSmartAccount,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData } from "viem";

// ✅ 7702 구현 ABI (execute / executeBatch)
const IMPL_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

// 필요 시 가져다 쓰기 위한 기본 EP(0.8)
export const ENTRYPOINT_V08 =
  "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789" as const;

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

/** ─────────────────────────────────────────────────────────
 *  ✅ sign 전용 (PK 필요): owner 기반 Simple7702 SmartAccount
 *  ───────────────────────────────────────────────────────── */
export async function getSmartAccount(opts?: {
  implementation?: `0x${string}`;
}) {
  const owner = getOwnerFromEnv();
  const implementation = (opts?.implementation ??
    getImplementationFromEnv()) as `0x${string}`;
  const sa = await toSimple7702SmartAccount({
    client: publicClient,
    owner,
    implementation,
  });
  return sa;
}

export async function getSmartAccountForSend() {
  return getSmartAccount();
}
export async function getSmartAccountForSponsor() {
  return getSmartAccount();
}

/** ─────────────────────────────────────────────────────────
 *  ✅ send 전용 (PK 불필요): 훅 기반 PK-less SmartAccount
 *  - sign.ts에서 만든 authorization 을 그대로 사용
 *  - initCode는 배포 없으므로 내부적으로 '0x'로 정규화
 *  ───────────────────────────────────────────────────────── */
// account.ts (getPklessSmartAccount 수정본)
export async function getPklessSmartAccount(opts: {
  accountAddress: `0x${string}`;
  implementation: `0x${string}`;
  entryPoint?: `0x${string}`;
}) {
  const ep = (opts.entryPoint ?? ENTRYPOINT_V08) as `0x${string}`;

  return toSmartAccount({
    address: opts.accountAddress,
    client: publicClient,
    entryPoint: { address: ep, version: "0.8" },

    // ✅ 여기 추가: viem이 요구하는 형태의 implementation 객체
    implementation: {
      async getAddress() {
        return opts.implementation; // 0x... 주소 반환
      },
    },

    // calls → impl.execute / executeBatch
    async encodeCalls(input: any) {
      const calls = Array.isArray(input) ? input : input?.calls ?? [];
      if (!Array.isArray(calls) || calls.length === 0) {
        throw new Error("encodeCalls: calls empty");
      }
      if (calls.length === 1) {
        const c = calls[0];
        return encodeFunctionData({
          abi: IMPL_ABI,
          functionName: "execute",
          args: [
            c.to as `0x${string}`,
            (c.value ?? 0n) as bigint,
            (c.data ?? "0x") as `0x${string}`,
          ],
        });
      }
      const tupleCalls = calls.map((c: any) => ({
        to: c.to as `0x${string}`,
        value: (c.value ?? 0n) as bigint,
        data: (c.data ?? "0x") as `0x${string}`,
      }));
      return encodeFunctionData({
        abi: IMPL_ABI,
        functionName: "executeBatch",
        args: [tupleCalls],
      });
    },

    // 배포 없음 → initCode = '0x' 유도
    async getFactoryArgs() {
      return { factory: undefined, factoryData: undefined };
    },

    async getNonce() {
      return 0n;
    },
    async getStubSignature() {
      return ("0x" + "00".repeat(64) + "1b") as `0x${string}`;
    },
    async isDeployed() {
      return true;
    },
  });
}
