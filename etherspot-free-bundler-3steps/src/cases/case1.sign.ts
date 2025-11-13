// src/cases/sign1.build.ts
// Sign only (PK needed). Reads out/case1.build.json → writes out/case1.signed.json
import "dotenv/config";
import { http, createWalletClient, type Hex as HexLike } from "viem";
import { chain, commonClient, publicClient } from "../client";
import { loadJson, saveJson, parseArgs } from "../shared/io";
import { bump, ENTRYPOINT_V08, getFeesL2Safe } from "../shared/helpers";
import { toSimple7702SmartAccount, createPaymasterClient } from "viem/account-abstraction";
import { getOwnerFromEnv } from "../account";
import type { BuiltTR, SignedUserOpFile } from "../shared/types";

// --- compat helpers ---
function getPrepareActionName(client: any) {
  if (typeof client.prepareUserOperation === "function") return "prepareUserOperation";
  if (typeof client.buildUserOperation === "function") return "buildUserOperation";
  if (typeof client.prepareUserOperationRequest === "function") return "prepareUserOperationRequest";
  return null;
}
async function prepareUserOperationCompat(client: any, params: any) {
  const fn = getPrepareActionName(client);
  if (!fn) throw new Error("No prepare/build user operation action found on bundler client.");
  return client[fn](params);
}
const to0x = (n: bigint | number) => (`0x${BigInt(n).toString(16)}`) as HexLike;
const concatHex = (a: HexLike, b: HexLike) =>
  ((a === "0x" ? "0x" : (a as string)) + (b as string).slice(2)) as HexLike;

function normalizeToV06Shape(uoAny: any) {
  let initCode: HexLike = (uoAny.initCode ?? "0x") as HexLike;
  if (uoAny.factory) {
    const factory: HexLike = uoAny.factory as HexLike;
    const factoryData: HexLike = (uoAny.factoryData ?? "0x") as HexLike;
    initCode = concatHex(factory, factoryData);
  }
  let paymasterAndData: HexLike = (uoAny.paymasterAndData ?? "0x") as HexLike;
  if (uoAny.paymaster) {
    const paymaster: HexLike = uoAny.paymaster as HexLike;
    const pmd: HexLike = (uoAny.paymasterData ?? "0x") as HexLike;
    paymasterAndData = concatHex(paymaster, pmd);
  }
  return {
    sender: uoAny.sender as HexLike,
    nonce: BigInt(uoAny.nonce ?? 0n),
    initCode,
    callData: (uoAny.callData ?? "0x") as HexLike,
    callGasLimit: BigInt(uoAny.callGasLimit ?? 0n),
    verificationGasLimit: BigInt(uoAny.verificationGasLimit ?? 0n),
    preVerificationGas: BigInt(uoAny.preVerificationGas ?? 0n),
    maxFeePerGas: BigInt(uoAny.maxFeePerGas ?? 0n),
    maxPriorityFeePerGas: BigInt(uoAny.maxPriorityFeePerGas ?? 0n),
    paymasterAndData,
    signature: (uoAny.signature ?? "0x") as HexLike,
  };
}

async function main() {
  const args = parseArgs();
  const input = (args.in || "out/case1.build.json") as string;
  const output = (args.out || "out/case1.signed.json") as string;

  const tr = loadJson<BuiltTR>(input) as any;

  // 1) SmartAccount (PK 필요)
  const owner = getOwnerFromEnv();
  const sa = await toSimple7702SmartAccount({
    client: publicClient,
    owner,
    implementation: tr.delegateAddress,
  });
  if (sa.address.toLowerCase() !== tr.accountAddress.toLowerCase()) {
    throw new Error(`sa.address(${sa.address}) != accountAddress(${tr.accountAddress})`);
  }

  // 2) Authorization 생성(필요 시) - EIP-7702
  let needAuthorization = Boolean(tr.needAuthorization);
  let authorization: any = tr.authorization;
  if (needAuthorization) {
    const chainId = await publicClient.getChainId(); // number
    const nonce = await publicClient.getTransactionCount({
      address: owner.address,
      blockTag: "latest",
    }); // number
    const walletClient = createWalletClient({ account: owner, chain, transport: http(process.env.RPC_URL!) });
    const auth = await walletClient.signAuthorization({
      address: tr.delegateAddress as HexLike,
      chainId,
      nonce,
    });
    // signAuthorization 반환 형태를 그대로 보존 (number/bigint 형태 유지)
    authorization = {
      address: auth.address,
      chainId: chainId,
      nonce: nonce,
      r: auth.r,
      s: auth.s,
      yParity: auth.yParity,
    };
  }

  // ← 여기 핵심: signUserOperation에는 배열(authorizations)로 전달하고,
  //               chainId/nonce는 number|bigint 그대로 사용(0x 변환 X).
  const authorizationsForSign =
    needAuthorization && authorization
      ? [{
          address: authorization.address as HexLike,
          chainId: authorization.chainId as number,   // number/bigint 유지
          nonce: authorization.nonce as number,       // number/bigint 유지
          r: authorization.r as HexLike,
          s: authorization.s as HexLike,
          yParity: authorization.yParity as 0 | 1,
        }]
      : undefined;

  const entryPointAddr = (tr.entryPointHint || ENTRYPOINT_V08) as HexLike;
  const entryPoint = { address: entryPointAddr, version: "0.8" } as const;

  const calls = tr.calls.map((c: any) => ({
    to: c.to as HexLike,
    value: BigInt(c.value),
    data: c.data as HexLike,
  }));

  // 3) Gas & Paymaster
  const { maxFeePerGas, maxPriorityFeePerGas } = await getFeesL2Safe();
  const paymaster = tr.paymasterUrl
    ? createPaymasterClient({ transport: http(tr.paymasterUrl) })
    : undefined;

  // 4) estimate (번들러: authorization 단수 키 허용)
  let gasEst: { callGasLimit?: bigint; verificationGasLimit?: bigint; preVerificationGas?: bigint } | undefined;
  try {
    const estParams: any = {
      account: sa,
      calls, entryPoint: entryPoint.address, // estimate/prepare는 string EP도 OK
      maxFeePerGas, maxPriorityFeePerGas,
    };
    if (needAuthorization && authorization) estParams.authorization = authorization;
    if (paymaster) { estParams.paymaster = paymaster; estParams.paymasterContext = tr.paymasterContext; }
    gasEst = await (commonClient as any).estimateUserOperationGas(estParams);
  } catch (e: any) {
    console.warn("[estimate] failed:", e?.shortMessage || e?.message);
  }

  const callGasLimit = bump(gasEst?.callGasLimit, 130n);
  const verificationGasLimit = bump(gasEst?.verificationGasLimit, 130n);
  const preVerificationGas = bump(gasEst?.preVerificationGas, 130n);

  // 5) prepare (서명 전 UO 생성)
  const prepareParams: any = {
    account: sa,
    calls, entryPoint: entryPoint.address,
    maxFeePerGas, maxPriorityFeePerGas,
    callGasLimit, verificationGasLimit, preVerificationGas,
  };
  if (needAuthorization && authorization) prepareParams.authorization = authorization;
  if (paymaster) { prepareParams.paymaster = paymaster; prepareParams.paymasterContext = tr.paymasterContext; }

  const unsignedAny = await prepareUserOperationCompat((commonClient as any), prepareParams);

  // v0.6 형태 normalize + 필수 bytes/숫자 정리
  const uoForSign: any = (() => {
    const u = { ...unsignedAny } as any;
    u.initCode = (u.initCode ?? "0x") as HexLike;
    u.callData = (u.callData ?? "0x") as HexLike;
    if (!u.paymasterAndData) {
      if (u.paymaster) {
        const pmd = (u.paymasterData ?? "0x") as HexLike;
        u.paymasterAndData = concatHex(u.paymaster as HexLike, pmd);
      } else {
        u.paymasterAndData = "0x";
      }
    }
    u.signature = "0x" as HexLike;
    u.nonce = BigInt(u.nonce ?? 0n);
    u.callGasLimit = BigInt(u.callGasLimit ?? 0n);
    u.verificationGasLimit = BigInt(u.verificationGasLimit ?? 0n);
    u.preVerificationGas = BigInt(u.preVerificationGas ?? 0n);
    u.maxFeePerGas = BigInt(u.maxFeePerGas ?? 0n);
    u.maxPriorityFeePerGas = BigInt(u.maxPriorityFeePerGas ?? 0n);
    return u;
  })();

  // 6) 서명 — 여기서 authorizations 배열 + entryPoint 객체 사용
  if (typeof (sa as any).signUserOperation !== "function") {
    throw new Error("SmartAccount.signUserOperation not found. Update viem/account-abstraction.");
  }
  const signParams: any = {
    entryPoint,                  // { address, version }
    userOperation: uoForSign,
  };
  if (authorizationsForSign) {
    signParams.authorizations = authorizationsForSign; // 배열!
  }

  const signature: `0x${string}` = await (sa as any).signUserOperation(signParams);

  // 7) 저장용(모든 숫자 -> 0x 문자열)
  const uoV06 = normalizeToV06Shape({ ...uoForSign, signature });
  const userOperationHex = {
    sender: uoV06.sender,
    nonce: to0x(uoV06.nonce),
    initCode: uoV06.initCode,
    callData: uoV06.callData,
    callGasLimit: to0x(uoV06.callGasLimit),
    verificationGasLimit: to0x(uoV06.verificationGasLimit),
    preVerificationGas: to0x(uoV06.preVerificationGas),
    maxFeePerGas: to0x(uoV06.maxFeePerGas),
    maxPriorityFeePerGas: to0x(uoV06.maxPriorityFeePerGas),
    paymasterAndData: uoV06.paymasterAndData,
    signature: uoV06.signature,
  };

  const out: SignedUserOpFile = {
    caseId: tr.caseId,
    chainId: tr.chainId,
    accountAddress: tr.accountAddress,
    delegateAddress: tr.delegateAddress,
    entryPoint: entryPoint.address,
    paymasterUrl: tr.paymasterUrl,
    paymasterContext: tr.paymasterContext,
    needAuthorization,
    authorization, // 참고 저장(사본)
    calls: tr.calls,
    userOperation: userOperationHex,
    notes: (tr.notes || "") + " | fully built & signed (ready to send)",
  };

  saveJson(output, out);
  console.log(`📝 saved: ${output}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
