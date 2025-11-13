// userop.send.ts
import "dotenv/config";
import { parseEther } from "viem";
import { commonClient, publicClient } from "./client";   // <-- both
import { getSmartAccountForSend } from "./account";       // <-- bundler-based factory
import { parseArgs } from "./utils";
import type { SignAuthorizationReturnType } from "viem";

function bump(x?: bigint, pct: bigint = 150n) { return x ? (x * pct) / 100n : undefined; }

async function getEntryPointAddress(): Promise<`0x${string}`> {
  const eps = (await commonClient.request({ method: "eth_supportedEntryPoints", params: [] })) as `0x${string}`[];
  if (!eps?.length) throw new Error("No supported EntryPoints from bundler");
  return eps[0];
}

async function main() {
  const args = parseArgs();
  const to = (args.to || process.env.TO) as `0x${string}`;
  const valueEth = args["value-eth"] || process.env.VALUE_ETH || "0.0000001";
  if (!to) throw new Error("Missing --to or TO in .env");

  const sa = await getSmartAccountForSend(); // <-- bundler client
  console.log("smartAccount.address =", sa.address);

  // ✅ L1 read via public RPC only
  const senderCode = await publicClient.getCode({ address: sa.address });

  let authorization: SignAuthorizationReturnType | undefined;
  const { address: delegateAddress } = sa.authorization;
  const expectedPrefix = `0xef0100${delegateAddress.toLowerCase().slice(2)}`;
  if (senderCode !== expectedPrefix) {
    authorization = await commonClient.signAuthorization(sa.authorization);
  }

  const entryPoint = await getEntryPointAddress();

  // fees from public RPC (not bundler)
  const fee = await publicClient.estimateFeesPerGas();
  const base = fee.baseFeePerGas ?? 5_000_000_000n;         // 5 gwei floor
  const pri  = fee.maxPriorityFeePerGas ?? 2_000_000_000n;  // 2 gwei floor
  const maxPriorityFeePerGas = (pri * 150n) / 100n;
  const maxFeePerGas = ((fee.maxFeePerGas ?? (base + pri)) * 150n) / 100n;

  const calls = [{ to, value: parseEther(valueEth) }];

  // estimate on bundler
  const gas = await commonClient.estimateUserOperationGas({
    account: sa,
    authorization,
    calls,
    entryPoint,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const callGasLimit = bump(gas.callGasLimit, 120n);
  const verificationGasLimit = bump(gas.verificationGasLimit, 120n);
  const preVerificationGas = bump(gas.preVerificationGas, 120n);

  // send on bundler
  const userOpHash = await commonClient.sendUserOperation({
    account: sa,
    authorization,
    calls,

    entryPoint,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  console.log("userOpHash =", userOpHash);

  const receipt = await commonClient.waitForUserOperationReceipt({
    hash: userOpHash,
    timeout: 180_000,
    pollingInterval: 3_000,
  });
  console.log("UserOp receipt =", receipt);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
