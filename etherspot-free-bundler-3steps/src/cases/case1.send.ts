// src/cases/send1.build.ts
// Send only (no PK). Reads out/case1.signed.json and sends via bundler RPC.
import "dotenv/config";
import { commonClient, publicClient } from "../client";
import { loadJson, parseArgs } from "../shared/io";
import { ENTRYPOINT_V08 } from "../shared/helpers";
import type { SignedUserOpFile } from "../shared/types";

function formatEth(wei: bigint, d = 6) {
  return `${(Number(wei) / 1e18).toFixed(d)} ETH`;
}

async function main() {
  const args = parseArgs();
  const input = (args.in || "out/case1.signed.json") as string;

  const file = loadJson<SignedUserOpFile>(input);
  const { userOperation, entryPoint, accountAddress } = file;

  const nativeBalance = await publicClient.getBalance({ address: accountAddress });
  console.log(`[balance] native=${formatEth(nativeBalance)} (addr=${accountAddress})`);
  console.log(`[rpc] entryPoint=${entryPoint || ENTRYPOINT_V08}`);

  // Bundler로 전송 (이미 서명 완료된 UO)
  const userOpHash = await commonClient.request({
    method: "eth_sendUserOperation",
    params: [userOperation, entryPoint || ENTRYPOINT_V08],
  });
  console.log("userOpHash =", userOpHash);

  // Receipt 폴링
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const receipt = await commonClient.request({
        method: "eth_getUserOperationReceipt",
        params: [userOpHash],
      });
      if (receipt) {
        console.log("UserOp receipt =", receipt);
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.warn("No receipt within timeout. Check bundler logs / policy.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
