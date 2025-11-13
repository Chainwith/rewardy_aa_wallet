// userop.sponsor.ts

/// <reference types="node" />
import "dotenv/config";
import { http, parseEther } from "viem";
import { createPaymasterClient } from "viem/account-abstraction";
import { commonClient, publicClient, chain } from "./client"; // ⬅️ import publicClient too
import { getSmartAccount } from "./account";
import { parseArgs } from "./utils";
import type { SignAuthorizationReturnType } from "viem";

async function getEntryPointAddress(): Promise<`0x${string}`> {
  const eps = (await commonClient.request({
    method: "eth_supportedEntryPoints",
    params: [],
  })) as `0x${string}`[];
  if (!eps?.length) throw new Error("No supported EntryPoints from bundler");
  return eps[0];
}

async function waitOrDebug(hash: `0x${string}`) {
  try {
    return await commonClient.waitForUserOperationReceipt({
      hash,
      timeout: 180_000,
      pollingInterval: 3_000,
    });
  } catch (e) {
    console.warn("Timed out. Debugging…");
    try {
      const uo = await commonClient.request({
        method: "eth_getUserOperationByHash",
        params: [hash],
      });
      console.log("eth_getUserOperationByHash =", uo);
    } catch (ee) {
      console.warn("eth_getUserOperationByHash failed:", ee);
    }
    try {
      const eps = await commonClient.request({
        method: "eth_supportedEntryPoints",
        params: [],
      });
      console.log("supported EntryPoints =", eps);
    } catch (ee) {
      console.warn("eth_supportedEntryPoints failed:", ee);
    }
    throw e;
  }
}

function bump(x?: bigint, pct: bigint = 150n) {
  return x ? (x * pct) / 100n : undefined; // +50% safety
}

async function main() {
  const args = parseArgs();

  const to = (args.to || process.env.TO) as `0x${string}`;
  const valueEth = args["value-eth"] || process.env.VALUE_ETH || "0.0000001";
  const paymasterUrl = args["paymaster-url"] || process.env.PAYMASTER_URL;
  const paymasterContextRaw =
    args["paymaster-context"] || process.env.PAYMASTER_CONTEXT || "";

  if (!to) throw new Error("Missing --to or TO in .env");
  if (!paymasterUrl)
    throw new Error("Missing --paymaster-url or PAYMASTER_URL");

  if (/pimlico/i.test(paymasterUrl) && !paymasterContextRaw) {
    console.warn(
      '⚠️ Pimlico: PAYMASTER_CONTEXT with {"sponsorshipPolicyId":"sp_..."} is typically required.'
    );
  }

  // Paymaster client (Pimlico)
  const paymasterClient = createPaymasterClient({
    transport: http(paymasterUrl),
  });

  // Parse context
  let paymasterContext: any | undefined;
  if (paymasterContextRaw) {
    try {
      paymasterContext = JSON.parse(paymasterContextRaw);
    } catch {
      throw new Error("PAYMASTER_CONTEXT must be valid JSON.");
    }
  }

  const smartAccount = await getSmartAccount();
  console.log("smartAccount.address =", smartAccount.address);

  // ✅ Use publicClient (full RPC) for eth_getCode
  const senderCode = await publicClient.getCode({
    address: smartAccount.address,
  });

  const [chainId, block] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber(),
  ]);
  console.log("[rpc]", { chainId, block: block.toString() });

  let authorization: SignAuthorizationReturnType | undefined;
  const { address: delegateAddress } = smartAccount.authorization;
  const expectedPrefix = `0xef0100${delegateAddress.toLowerCase().slice(2)}`;
  if (senderCode !== expectedPrefix) {
    authorization = await commonClient.signAuthorization(
      smartAccount.authorization
    );
  }

  // Bundler’s EntryPoint
  const entryPoint = await getEntryPointAddress();
  console.log("Using EntryPoint:", entryPoint);

  // ✅ Get fees from public RPC (not bundler)
  const feeData = await publicClient.estimateFeesPerGas();
  const base = feeData.baseFeePerGas ?? 2_000_000_000n; // 2 gwei floor
  const pri = feeData.maxPriorityFeePerGas ?? 2_000_000_000n; // 2 gwei floor
  const maxPriorityFeePerGas = bump(pri)!; // +50%
  const maxFeePerGas = bump(feeData.maxFeePerGas ?? base + pri)!;

  console.log(
    "fees(gwei) =",
    "maxFeePerGas:",
    Number(maxFeePerGas) / 1e9,
    "maxPriorityFeePerGas:",
    Number(maxPriorityFeePerGas) / 1e9
  );

  const valueWei = parseEther(valueEth);

  // ✅ Balance from public RPC
  const bal = await publicClient.getBalance({ address: smartAccount.address });
  if (bal < valueWei) {
    console.warn(
      `⚠️ smartAccount balance is low for sending ${valueEth} ETH (balance=${bal} wei).`
    );
  }

  const calls = [{ to, value: valueWei }];

  // First: gas estimation WITHOUT paymaster (avoid pm_getPaymasterStubData)
  const gasBare = await commonClient.estimateUserOperationGas({
    account: smartAccount,
    authorization,
    calls,
    entryPoint,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  // Bump limits
  const callGasLimit = bump(gasBare.callGasLimit, 130n);
  const verificationGasLimit = bump(gasBare.verificationGasLimit, 130n);
  const preVerificationGas = bump(gasBare.preVerificationGas, 130n);

  console.log(
    "estimated gas (bare) =",
    "call:",
    gasBare.callGasLimit?.toString(),
    "verify:",
    gasBare.verificationGasLimit?.toString(),
    "preverify:",
    gasBare.preVerificationGas?.toString()
  );

  // Send with paymaster (Pimlico will run pm_getPaymasterData here)
  const userOpHash = await commonClient.sendUserOperation({
    account: smartAccount,
    authorization,
    calls,

    entryPoint,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,

    paymaster: paymasterClient,
    paymasterContext,
  });

  console.log("userOpHash =", userOpHash);

  const receipt = await waitOrDebug(userOpHash);
  console.log("UserOp receipt =", receipt);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
