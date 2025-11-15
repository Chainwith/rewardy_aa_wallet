// src/cases/case3.send.ts
import "dotenv/config";
import { http } from "viem";
import { createPaymasterClient } from "viem/account-abstraction";
import { commonClient, publicClient } from "../client";
import { getSmartAccount } from "../account";
import { loadJson, parseArgs } from "../shared/io";
import { getFeesL2Safe, waitOrDebug, bump, ENTRYPOINT_V08 } from "../shared/helpers";
import type { SignedTR } from "../shared/types";

// ────────────────────────────────────────────────────────────
// Formatting helpers (tiny values visible)
// ────────────────────────────────────────────────────────────
function fmtWei(wei: bigint) {
  return `${wei.toString()} wei`;
}
function fmtGwei(wei?: bigint) {
  return wei !== undefined ? `${(Number(wei) / 1e9).toFixed(6)} gwei` : "-";
}
// default 12 digits to avoid rounding to zero for tiny costs
function fmtEth(wei: bigint, digits = 12) {
  return `${(Number(wei) / 1e18).toFixed(digits)} ETH`;
}

const sumCallValues = (calls: { value: bigint }[]) =>
  calls.reduce((a, c) => a + (c.value || 0n), 0n);

async function main() {
  const args = parseArgs();
  const input = (args.in || "out/case3.signed.json") as string;

  // 1) 입력 로드
  const tr = loadJson<SignedTR>(input);
  const entryPoint = ENTRYPOINT_V08;

  // 2) 수수료 상한
  const { maxFeePerGas, maxPriorityFeePerGas } = await getFeesL2Safe();

  // 3) 서명 계정 생성 (7702 simple SA)
  const sa = await getSmartAccount({ implementation: tr.delegateAddress });

  if (sa.address.toLowerCase() !== tr.accountAddress.toLowerCase()) {
    throw new Error(`sa.address(${sa.address}) != sender(${tr.accountAddress}).`);
  }

  // 4) Paymaster
  const paymaster = tr.paymasterUrl
    ? createPaymasterClient({ transport: http(tr.paymasterUrl) })
    : undefined;

  // 5) Authorization 정규화
  const auth: any = (tr as any).authorization;
  if (auth) {
    if (typeof auth.chainId === "number") auth.chainId = `0x${auth.chainId.toString(16)}`;
    if (typeof auth.nonce === "number")   auth.nonce   = `0x${BigInt(auth.nonce).toString(16)}`;
  }

  const needAuthorization =
    typeof (tr as any).needAuthorization === "boolean" ? (tr as any).needAuthorization : !!auth;

  console.log(`[mode] ${needAuthorization ? "auth=ON" : "auth=OFF (already delegated)"}`);

  // 6) calls/잔액/로그
  const calls = tr.calls.map((c) => ({
    to: c.to as `0x${string}`,
    value: BigInt(c.value),
    data: c.data as `0x${string}`,
  }));
  const totalValue = sumCallValues(calls);

  const nativeBalance = await publicClient.getBalance({ address: sa.address });
  console.log(`[rpc] entryPoint=${entryPoint}`);
  console.log(`[balance] native=${fmtEth(nativeBalance)} (addr=${sa.address})`);
  if (maxFeePerGas && maxPriorityFeePerGas) {
    console.log(
      `[gas] maxFeePerGas=${fmtGwei(maxFeePerGas)} maxPriorityFeePerGas=${fmtGwei(maxPriorityFeePerGas)}`
    );
  }
  if (totalValue > 0n) {
    console.log(`[calls] total ETH value to send = ${fmtEth(totalValue)}`);
  }

  if (needAuthorization) {
    if (!auth || !auth.r || !auth.s || (auth.yParity !== 0 && auth.yParity !== 1)) {
      throw new Error("Missing/invalid authorization (r/s/yParity). Re-run sign step.");
    }
  }

  // 7) estimateUserOperationGas (+ PM extra)
  let gasEst:
    | {
        callGasLimit?: bigint;
        verificationGasLimit?: bigint;
        preVerificationGas?: bigint;
        paymasterVerificationGasLimit?: bigint;
        paymasterPostOpGasLimit?: bigint;
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
    console.log("[estimate] OK:", gasEst);
  } catch (e: any) {
    console.warn(
      `[estimate] failed${paymaster ? " (even with PM)" : ""}: ${e?.shortMessage || e?.message}`
    );
    gasEst = {
      callGasLimit: 650_000n,
      verificationGasLimit: 900_000n,
      preVerificationGas: 120_000n,
    };
    console.warn("[estimate] fallback gas used:", gasEst);
  }

  // 8) 안전 마진 적용 (user & PM 전용 가스 예산 구분)
  const callGasRaw = gasEst?.callGasLimit ?? 0n;
  const verGasRaw = gasEst?.verificationGasLimit ?? 0n;
  const preGasRaw = gasEst?.preVerificationGas ?? 0n;
  const pmVerRaw = gasEst?.paymasterVerificationGasLimit ?? 0n;
  const pmPostRaw = gasEst?.paymasterPostOpGasLimit ?? 0n;

  const callGas = bump(callGasRaw, 130n) ?? 0n;
  const verGas = bump(verGasRaw, 130n) ?? 0n;
  const preGas = bump(preGasRaw, 130n) ?? 0n;
  const pmVer = bump(pmVerRaw, 130n) ?? 0n;
  const pmPost = bump(pmPostRaw, 130n) ?? 0n;

  // 유저 관점 AA 전체 예산
  const gasBudgetUser = callGas + verGas + preGas;
  // Paymaster 전용(있다면) 예산
  const gasBudgetPmOnly = pmVer + pmPost;

  // 스폰서 총 예산(보수적: user + pmOnly)
  const sponsorBudget = paymaster ? gasBudgetUser + gasBudgetPmOnly : 0n;
  const sponsorCostEst = paymaster && maxFeePerGas ? sponsorBudget * maxFeePerGas : 0n;

  // 프리펀드/스폰서 가이드
  if (paymaster) {
    console.log(
      `[prefund][with PM] required(native)[sender] ≈ ${fmtEth(totalValue)} (gas sponsored)`
    );
    console.log(
      `[payer][estimate] sponsor gasBudget(user)=${gasBudgetUser.toString()} pmExtra=${gasBudgetPmOnly.toString()} total=${(
        gasBudgetUser + gasBudgetPmOnly
      ).toString()}`
    );
    console.log(
      `[payer][estimate] maxFeePerGas=${fmtGwei(
        maxFeePerGas
      )} → sponsorCost≈ ${fmtWei(sponsorCostEst)} (${fmtEth(sponsorCostEst)})`
    );
    if (nativeBalance < totalValue) {
      const delta = totalValue - nativeBalance;
      console.warn(
        `[prefund][with PM] NOT ENOUGH. need=${fmtEth(totalValue)} have=${fmtEth(
          nativeBalance
        )} delta=${fmtEth(delta)}`
      );
    }
  } else {
    const gasBudget = gasBudgetUser;
    const gasCost = maxFeePerGas ? gasBudget * maxFeePerGas : 0n;
    const need = gasCost + totalValue;
    console.log(
      `[prefund][no PM] gasBudget=${gasBudget.toString()} gasCost≈ ${fmtWei(gasCost)} (${fmtEth(
        gasCost
      )}) required≈ ${fmtEth(need)}`
    );
    if (nativeBalance < need) {
      const delta = need - nativeBalance;
      console.warn(
        `[prefund][no PM] NOT ENOUGH. need≈${fmtEth(need)} have=${fmtEth(nativeBalance)} delta≈${fmtEth(
          delta
        )}`
      );
    }
  }

  // 9) 전송
  const sendParams: any = {
    account: sa,
    calls,
    entryPoint,
    maxFeePerGas,
    maxPriorityFeePerGas,
    callGasLimit: callGas,
    verificationGasLimit: verGas,
    preVerificationGas: preGas,
  };
  if (needAuthorization) sendParams.authorization = auth;
  if (paymaster) {
    sendParams.paymaster = paymaster;
    sendParams.paymasterContext = tr.paymasterContext;
  }

  const userOpHash = await commonClient.sendUserOperation(sendParams);
  console.log("userOpHash =", userOpHash);

  const receipt = await waitOrDebug(userOpHash);
  console.log("UserOp receipt =", receipt);

  // 10) 실제 비용 vs 추정 비교 (스폰서 관점)
  const actualUsed = (receipt as any)?.actualGasUsed ?? 0n;
  const actualCost = (receipt as any)?.actualGasCost ?? 0n;
  const effPrice = (receipt as any)?.receipt?.effectiveGasPrice as bigint | undefined;

  if (paymaster) {
    console.log(
      `[payer][estimate] sponsorCost≈ ${fmtWei(sponsorCostEst)} (${fmtEth(sponsorCostEst)})`
    );
    console.log(
      `[payer][actual]   usedGas=${actualUsed} actualCost≈ ${fmtWei(actualCost)} (${fmtEth(
        actualCost
      )})` + (effPrice ? ` (effGasPrice=${fmtGwei(effPrice)})` : "")
    );
    const delta = actualCost - sponsorCostEst;
    const sign = delta >= 0n ? "+" : "";
    console.log(
      `[payer][delta]    ${sign}${fmtWei(delta)} (${sign}${fmtEth(delta)}) (actual - estimate)`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
