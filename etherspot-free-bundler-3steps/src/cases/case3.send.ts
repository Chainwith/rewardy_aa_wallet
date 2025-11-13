// src/cases/case1.send.ts  (case2/3/4는 기본 in만 변경)
import "dotenv/config";
import { http } from "viem";
import { createPaymasterClient } from "viem/account-abstraction";
import { commonClient, publicClient } from "../client";
import { getSmartAccount } from "../account";
import { loadJson, parseArgs } from "../shared/io";
import { getFeesL2Safe, waitOrDebug, bump, ENTRYPOINT_V08 } from "../shared/helpers";
import type { SignedTR } from "../shared/types";

function formatEth(wei: bigint, d = 6) { return `${(Number(wei) / 1e18).toFixed(d)} ETH`; }
function formatGwei(wei: bigint) { return `${(Number(wei) / 1e9).toFixed(3)} gwei`; }
const sumCallValues = (calls: { value: bigint }[]) => calls.reduce((a, c) => a + (c.value || 0n), 0n);

async function main() {
  const args = parseArgs();
  const input = (args.in || "out/case3.signed.json") as string;

  const tr = loadJson<SignedTR>(input);
  const entryPoint = ENTRYPOINT_V08;
  const { maxFeePerGas, maxPriorityFeePerGas } = await getFeesL2Safe();
  const sa = await getSmartAccount({ implementation: tr.delegateAddress });

  if (sa.address.toLowerCase() !== tr.accountAddress.toLowerCase()) {
    throw new Error(`sa.address(${sa.address}) != sender(${tr.accountAddress}).`);
  }

  const paymaster = tr.paymasterUrl ? createPaymasterClient({ transport: http(tr.paymasterUrl) }) : undefined;

  const auth: any = (tr as any).authorization;
  if (auth) {
    if (typeof auth.chainId === "number") auth.chainId = `0x${auth.chainId.toString(16)}`;
    if (typeof auth.nonce === "number")   auth.nonce   = `0x${BigInt(auth.nonce).toString(16)}`;
  }

  const needAuthorization =
    typeof (tr as any).needAuthorization === "boolean" ? (tr as any).needAuthorization : !!auth;

  console.log(`[mode] ${needAuthorization ? "auth=ON" : "auth=OFF (already delegated)"}`);

  const calls = tr.calls.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data as `0x${string}` }));
  const totalValue = sumCallValues(calls);

  const nativeBalance = await publicClient.getBalance({ address: sa.address });
  console.log(`[rpc] entryPoint=${entryPoint}`);
  console.log(`[balance] native=${formatEth(nativeBalance)} (addr=${sa.address})`);
  console.log(`[gas] maxFeePerGas=${formatGwei(maxFeePerGas!)} maxPriorityFeePerGas=${formatGwei(maxPriorityFeePerGas!)}`);
  if (totalValue > 0n) console.log(`[calls] total ETH value to send = ${formatEth(totalValue)}`);

  if (needAuthorization) {
    if (!auth || !auth.r || !auth.s || (auth.yParity !== 0 && auth.yParity !== 1)) {
      throw new Error("Missing/invalid authorization (r/s/yParity). Re-run sign step.");
    }
  }

  // estimate
  let gasEst: { callGasLimit?: bigint; verificationGasLimit?: bigint; preVerificationGas?: bigint } | undefined;
  try {
    const estParams: any = {
      account: sa, calls, entryPoint, maxFeePerGas, maxPriorityFeePerGas,
    };
    if (needAuthorization) estParams.authorization = auth;
    if (paymaster) { estParams.paymaster = paymaster; estParams.paymasterContext = tr.paymasterContext; }
    gasEst = await commonClient.estimateUserOperationGas(estParams);

    const callGas = gasEst.callGasLimit ?? 0n;
    const verGas = gasEst.verificationGasLimit ?? 0n;
    const preGas = gasEst.preVerificationGas ?? 0n;
    const gasBudget = callGas + verGas + preGas;

    if (paymaster) {
      console.log(`[prefund][with PM] required(native) ≈ ${formatEth(totalValue)} (gas sponsored)`);
      if (nativeBalance < totalValue) {
        console.warn(`[prefund][with PM] NOT ENOUGH. need=${formatEth(totalValue)} have=${formatEth(nativeBalance)} delta=${formatEth(totalValue - nativeBalance)}`);
      }
    } else {
      const gasCost = gasBudget * maxFeePerGas!;
      const need = gasCost + totalValue;
      console.log(`[prefund][no PM] gasBudget=${gasBudget.toString()} gasCost≈${formatEth(gasCost)} required≈${formatEth(need)}`);
      if (nativeBalance < need) {
        console.warn(`[prefund][no PM] NOT ENOUGH. need≈${formatEth(need)} have=${formatEth(nativeBalance)} delta≈${formatEth(need - nativeBalance)}`);
      }
    }
  } catch (e: any) {
    console.warn(`[estimate] failed${paymaster ? " (even with PM)" : ""}: ${e?.shortMessage || e?.message}`);
  }

  // send
  const callGasLimit = bump(gasEst?.callGasLimit, 130n);
  const verificationGasLimit = bump(gasEst?.verificationGasLimit, 130n);
  const preVerificationGas = bump(gasEst?.preVerificationGas, 130n);

  const sendParams: any = {
    account: sa, calls, entryPoint, maxFeePerGas, maxPriorityFeePerGas,
    callGasLimit, verificationGasLimit, preVerificationGas,
  };
  if (needAuthorization) sendParams.authorization = auth;
  if (paymaster) { sendParams.paymaster = paymaster; sendParams.paymasterContext = tr.paymasterContext; }

  const userOpHash = await commonClient.sendUserOperation(sendParams);
  console.log("userOpHash =", userOpHash);

  const receipt = await waitOrDebug(userOpHash);
  console.log("UserOp receipt =", receipt);
}
main().catch((e) => { console.error(e); process.exit(1); });
