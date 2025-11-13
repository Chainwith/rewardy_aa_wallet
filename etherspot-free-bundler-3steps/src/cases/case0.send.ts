// send.ts
import "dotenv/config";
import { http } from "viem";
import { createPaymasterClient } from "viem/account-abstraction";
import { commonClient, publicClient } from "../client";
import { getSmartAccount } from "../account";
import { loadJson, parseArgs } from "../shared/io";
import {
  getFeesL2Safe,
  waitOrDebug,
  bump,
  ENTRYPOINT_V08,
} from "../shared/helpers";
import type { SignedTR } from "../shared/types";

/* ---------- small log helpers ---------- */
function formatEth(wei: bigint, decimals = 6) {
  return `${(Number(wei) / 1e18).toFixed(decimals)} ETH`;
}
function formatGwei(wei: bigint) {
  return `${(Number(wei) / 1e9).toFixed(3)} gwei`;
}
const sumCallValues = (calls: { value: bigint }[]) =>
  calls.reduce((a, c) => a + (c.value || 0n), 0n);

async function main() {
  const args = parseArgs();
  const input = (args.in || "out/case0.signed.json") as string;

  // 0) load signed TR
  const tr = loadJson<SignedTR>(input);

  // 1) runtime setup
  const entryPoint = ENTRYPOINT_V08; // v0.8 고정 사용
  const { maxFeePerGas, maxPriorityFeePerGas } = await getFeesL2Safe();
  const sa = await getSmartAccount({ implementation: tr.delegateAddress });

  // sa.address == sender 확인
  if (sa.address.toLowerCase() !== tr.accountAddress.toLowerCase()) {
    throw new Error(`sa.address(${sa.address}) != sender(${tr.accountAddress}).`);
  }

  // 2) 위임/인증 분기: 파일 힌트 우선, 없으면 런타임 추론
  const paymaster = tr.paymasterUrl
    ? createPaymasterClient({ transport: http(tr.paymasterUrl) })
    : undefined;

  const auth: any = tr.authorization;
  // 숫자로 들어오면 hex로 강제
  if (auth) {
    if (typeof (auth as any).chainId === "number")
      (auth as any).chainId = `0x${(auth as any).chainId.toString(16)}`;
    if (typeof (auth as any).nonce === "number")
      (auth as any).nonce = `0x${BigInt((auth as any).nonce).toString(16)}`;
  }

  // needAuthorization: 파일 값 우선, 없으면 "authorization 객체 존재 여부"로 추론
  const needAuthorization =
    typeof (tr as any).needAuthorization === "boolean"
      ? (tr as any).needAuthorization
      : !!auth;

  console.log(
    `[mode] ${needAuthorization ? "Using EIP-7702 authorization (temporary delegation)" : "Already delegated (no authorization)"}`
  );

  // calls
  const calls = tr.calls.map((c) => ({
    to: c.to,
    value: BigInt(c.value),
    data: c.data as `0x${string}`,
  }));
  const totalValue = sumCallValues(calls);

  // balances & gas logs
  const nativeBalance = await publicClient.getBalance({ address: sa.address });
  console.log(`[rpc] entryPoint=${entryPoint}`);
  console.log(`[balance] native=${formatEth(nativeBalance)} (addr=${sa.address})`);
  if (totalValue > 0n) {
    console.log(`[calls] total ETH value to send = ${formatEth(totalValue)}`);
  }
  console.log(
    `[gas] maxFeePerGas=${formatGwei(maxFeePerGas!)} maxPriorityFeePerGas=${formatGwei(
      maxPriorityFeePerGas!
    )}`
  );

  if (needAuthorization) {
    // 미위임인데 authorization 없거나 필드 불완전 → 중단
    if (!auth || !auth.r || !auth.s || (auth.yParity !== 0 && auth.yParity !== 1)) {
      throw new Error("Missing/invalid authorization (r/s/yParity). Re-run sign.ts.");
    }
  }

  // 3) estimate (PM 있으면 같이 넣어서 AA21 방지)
  let gasEst:
    | {
        callGasLimit?: bigint;
        verificationGasLimit?: bigint;
        preVerificationGas?: bigint;
      }
    | undefined;

  try {
    const estParams: any = {
      account: sa,
      calls,
      entryPoint,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
    if (needAuthorization) estParams.authorization = auth;
    if (paymaster) {
      estParams.paymaster = paymaster;
      estParams.paymasterContext = tr.paymasterContext;
    }

    gasEst = await commonClient.estimateUserOperationGas(estParams);

    const callGas = gasEst.callGasLimit ?? 0n;
    const verGas = gasEst.verificationGasLimit ?? 0n;
    const preGas = gasEst.preVerificationGas ?? 0n;
    const gasBudget = callGas + verGas + preGas;

    if (paymaster) {
      // 가스 스폰서 → 콜 value만 필요
      console.log(
        `[prefund][with PM] required(native) ≈ ${formatEth(totalValue)}  (gas sponsored)`
      );
      if (nativeBalance < totalValue) {
        console.warn(
          `[prefund][with PM] NOT ENOUGH. need=${formatEth(totalValue)} have=${formatEth(
            nativeBalance
          )} delta=${formatEth(totalValue - nativeBalance)}`
        );
      } else {
        console.log(
          `[prefund][with PM] OK. have=${formatEth(nativeBalance)} >= need=${formatEth(
            totalValue
          )}`
        );
      }
    } else {
      // PM 없음 → 가스+value 모두 필요
      const gasCost = gasBudget * maxFeePerGas!;
      const need = gasCost + totalValue;
      console.log(
        `[prefund][no PM] gasBudget=${gasBudget.toString()} gasCost≈${formatEth(
          gasCost
        )} required≈${formatEth(need)}`
      );
      if (nativeBalance < need) {
        console.warn(
          `[prefund][no PM] NOT ENOUGH. need≈${formatEth(need)} have=${formatEth(
            nativeBalance
          )} delta≈${formatEth(need - nativeBalance)}`
        );
      } else {
        console.log(
          `[prefund][no PM] OK. have=${formatEth(nativeBalance)} >= need≈${formatEth(need)}`
        );
      }
    }
  } catch (e: any) {
    console.warn(
      `[estimate] failed${paymaster ? " (even with PM)" : ""}: ${e?.shortMessage || e?.message}`
    );
  }

  // 4) send
  let userOpHash: `0x${string}`;

  // bump for safety
  const callGasLimit = bump(gasEst?.callGasLimit, 130n);
  const verificationGasLimit = bump(gasEst?.verificationGasLimit, 130n);
  const preVerificationGas = bump(gasEst?.preVerificationGas, 130n);

  const sendParams: any = {
    account: sa,
    calls,
    entryPoint,
    maxFeePerGas,
    maxPriorityFeePerGas,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas,
  };
  if (needAuthorization) sendParams.authorization = auth;
  if (paymaster) {
    sendParams.paymaster = paymaster;
    sendParams.paymasterContext = tr.paymasterContext;
  }

  userOpHash = await commonClient.sendUserOperation(sendParams);

  console.log("userOpHash =", userOpHash);
  const receipt = await waitOrDebug(userOpHash);
  console.log("UserOp receipt =", receipt);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
