// src/cases/estimate-gas.ts
import "dotenv/config";
import { http, type Hex } from "viem";
import { createPaymasterClient } from "viem/account-abstraction";
import { commonClient, publicClient } from "../client";
import { loadJson, parseArgs, saveJson } from "../shared/io";
import { getFeesL2Safe, bump } from "../shared/helpers";
import type { SignedTR, Call as BuiltCall } from "../shared/types";
import { getPklessSmartAccount, ENTRYPOINT_V08 } from "../account";

function fmtEth(wei: bigint, d = 6) {
  return `${(Number(wei) / 1e18).toFixed(d)} ETH`;
}
function fmtGwei(wei?: bigint) {
  return wei ? `${(Number(wei) / 1e9).toFixed(3)} gwei` : "-";
}
const sumValues = (calls: { value: bigint }[]) =>
  calls.reduce((a, c) => a + (c.value || 0n), 0n);

type EstOut = {
  entryPoint: Hex;
  usedPaymaster: boolean;
  needAuthorization: boolean;
  gas: {
    callGasLimit?: string;
    verificationGasLimit?: string;
    preVerificationGas?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  };
  budgets: {
    totalCallValueWei: string;
    gasBudgetWei: string;            // call + verification + preVerification
    gasCostWeiNoPM?: string;         // (no PM) gasBudget * maxFeePerGas
    requiredNativeNoPM?: string;     // (no PM) gasCost + totalCallValue
    requiredNativeWithPM: string;    // (with PM) == totalCallValue
    sponsorCostWei?: string;         // ✅ Paymaster(payer)가 부담할 네이티브 비용
  };
};

async function main() {
  const args = parseArgs();
  const input = (args.in || "out/case3.build.json") as string;
  const out = (args.out || "out/estimate-gas.json") as string;

  // 1) 입력 로드
  const tr = loadJson<SignedTR>(input);

  // 2) entryPoint 선택 (힌트 우선)
  const entryPoint = (tr.entryPointHint || ENTRYPOINT_V08) as Hex;

  // 3) 수수료 상한
  const { maxFeePerGas, maxPriorityFeePerGas } = await getFeesL2Safe();

  // 4) 7702 PK-less SmartAccount (사인 없이 calls 인코딩 전용)
  const sa = await getPklessSmartAccount({
    accountAddress: tr.accountAddress as Hex,
    implementation: tr.delegateAddress as Hex,
    entryPoint,
  });

  // 5) Paymaster(v2) (선택)
  const usedPM = !!tr.paymasterUrl;
  const paymaster = usedPM
    ? createPaymasterClient({ transport: http(tr.paymasterUrl!) })
    : undefined;

  // 6) Authorization 정규화(있으면 사용, 없으면 생략)
  const needAuthorization =
    typeof (tr as any).needAuthorization === "boolean"
      ? (tr as any).needAuthorization
      : !!(tr as any).authorization;

  const auth: any = (tr as any).authorization;
  if (needAuthorization && auth) {
    if (typeof auth.chainId === "number")
      auth.chainId = `0x${auth.chainId.toString(16)}`;
    if (typeof auth.nonce === "number")
      auth.nonce = `0x${BigInt(auth.nonce).toString(16)}`;
  }

  // 7) calls & 잔액/로그
  const calls = tr.calls.map((c: BuiltCall) => ({
    to: c.to as Hex,
    value: BigInt(c.value),
    data: c.data as Hex,
  }));
  const totalValue = sumValues(calls);

  const nativeBalance = await publicClient.getBalance({
    address: sa.address as Hex,
  });

  console.log(`[rpc] entryPoint=${entryPoint}`);
  console.log(`[addr] ${sa.address} | native=${fmtEth(nativeBalance)}`);
  console.log(
    `[gas]  maxFeePerGas=${fmtGwei(
      maxFeePerGas
    )}  maxPriorityFeePerGas=${fmtGwei(maxPriorityFeePerGas)}`
  );
  if (totalValue > 0n)
    console.log(`[calls] total value to send = ${fmtEth(totalValue)}`);
  console.log(
    `[mode] PM=${usedPM ? "ON" : "OFF"} | auth=${
      needAuthorization ? "ON" : "OFF"
    }`
  );

  // 8) estimateUserOperationGas
  let gasEst: {
    callGasLimit?: bigint;
    verificationGasLimit?: bigint;
    preVerificationGas?: bigint;
  } = {};
  try {
    const estParams: any = {
      account: sa,
      calls,
      entryPoint,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
    if (needAuthorization && auth) estParams.authorization = auth;
    if (usedPM) {
      estParams.paymaster = paymaster;
      estParams.paymasterContext = tr.paymasterContext ?? undefined;
    }

    gasEst = await commonClient.estimateUserOperationGas(estParams);
    console.log("[estimate] OK:", gasEst);
  } catch (e: any) {
    // 번들러 미가용/정책 미충족 등일 때 폴백
    console.warn(
      `[estimate] failed${
        usedPM ? " (even with PM)" : ""
      }: ${e?.shortMessage || e?.message}`
    );
    gasEst = {
      callGasLimit: 650_000n,
      verificationGasLimit: 900_000n,
      preVerificationGas: 120_000n,
    };
    console.warn("[estimate] fallback gas used:", gasEst);
  }

  // 9) 결과/예산 집계 (+ 안전 마진)
  const callGasLimit = bump(gasEst.callGasLimit, 130n);
  const verificationGasLimit = bump(gasEst.verificationGasLimit, 130n);
  const preVerificationGas = bump(gasEst.preVerificationGas, 130n);

  const gasBudget =
    (callGasLimit ?? 0n) +
    (verificationGasLimit ?? 0n) +
    (preVerificationGas ?? 0n);

  const gasCostNoPM = maxFeePerGas ? gasBudget * maxFeePerGas : undefined;
  const requiredNoPM =
    gasCostNoPM !== undefined ? gasCostNoPM + totalValue : undefined;

  // Paymaster가 있으면 유저는 콜 밸류만 준비
  const requiredWithPM = totalValue;

  // ✅ Paymaster(payer)가 부담할 네이티브 비용
  const sponsorCostWei =
    usedPM && maxFeePerGas ? gasBudget * maxFeePerGas : undefined;

  const outJson: EstOut = {
    entryPoint,
    usedPaymaster: usedPM,
    needAuthorization,
    gas: {
      callGasLimit: callGasLimit?.toString(),
      verificationGasLimit: verificationGasLimit?.toString(),
      preVerificationGas: preVerificationGas?.toString(),
      maxFeePerGas: maxFeePerGas?.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas?.toString(),
    },
    budgets: {
      totalCallValueWei: totalValue.toString(),
      gasBudgetWei: gasBudget.toString(),
      gasCostWeiNoPM: gasCostNoPM?.toString(),
      requiredNativeNoPM: requiredNoPM?.toString(),
      requiredNativeWithPM: requiredWithPM.toString(),
      sponsorCostWei: sponsorCostWei?.toString(), // ✅ NEW
    },
  };

  console.log("\n=== Estimated Gas (JSON) ===");
  console.log(JSON.stringify(outJson, null, 2));

  // 10) 파일 저장 (선택)
  try {
    saveJson(out, outJson);
    console.log(`[write] saved → ${out}`);
  } catch {
    // 저장 실패해도 치명적 아님
  }

  // 11) 프리펀드/스폰서 가이드
  if (usedPM) {
    console.log(
      `[prefund][with PM] need(native)[sender] ≈ ${fmtEth(
        requiredWithPM
      )} (gas is sponsored)`
    );
    if (sponsorCostWei !== undefined) {
      console.log(
        `[payer] estimated native sponsor cost ≈ ${fmtEth(sponsorCostWei)}`
      );
    }
    if (nativeBalance < requiredWithPM) {
      console.warn(
        `[prefund][with PM] NOT ENOUGH (sender): need=${fmtEth(
          requiredWithPM
        )} have=${fmtEth(nativeBalance)} delta=${fmtEth(
          requiredWithPM - nativeBalance
        )}`
      );
    }
  } else if (requiredNoPM !== undefined && gasCostNoPM !== undefined) {
    console.log(
      `[prefund][no PM] gasBudget=${gasBudget.toString()} gasCost≈${fmtEth(
        gasCostNoPM
      )} required≈${fmtEth(requiredNoPM)}`
    );
    if (nativeBalance < requiredNoPM) {
      console.warn(
        `[prefund][no PM] NOT ENOUGH: need≈${fmtEth(
          requiredNoPM
        )} have=${fmtEth(nativeBalance)} delta≈${fmtEth(
          requiredNoPM - nativeBalance
        )}`
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
