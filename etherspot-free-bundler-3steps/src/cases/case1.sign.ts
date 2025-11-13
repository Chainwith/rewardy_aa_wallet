// src/cases/case1.sign.ts
import "dotenv/config";
import { http, createWalletClient } from "viem";
import { chain, commonClient, publicClient } from "../client";
import { getOwnerFromEnv } from "../account";
import { loadJson, saveJson, parseArgs } from "../shared/io";
import { createPaymaster, bump, ENTRYPOINT_V08, getFeesL2Safe } from "../shared/helpers";
import { toSimple7702SmartAccount } from "viem/account-abstraction";
import type { BuiltTR, SignedUserOpFile } from "../shared/types";

type HexLike = `0x${string}`;
type UoGas = { callGasLimit?: bigint; verificationGasLimit?: bigint; preVerificationGas?: bigint };

const to0x = (n: bigint | number) => (`0x${BigInt(n).toString(16)}`) as HexLike;
const concatHex = (a: HexLike, b: HexLike) => ((a === "0x" ? "0x" : (a as string)) + (b as string).slice(2)) as HexLike;

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

  // 1) 7702 위임 필요 여부
  const senderCode = await publicClient.getCode({ address: tr.accountAddress as HexLike });
  const expectedPrefix = (`0xef0100${tr.delegateAddress.toLowerCase().slice(2)}`) as HexLike;
  const alreadyDelegated =
    typeof senderCode === "string" &&
    senderCode.length >= expectedPrefix.length &&
    senderCode.toLowerCase().startsWith(expectedPrefix.toLowerCase());
  const needAuthorization = Boolean(process.env.FORCE_AUTH) ? true : !alreadyDelegated;

  // 2) SmartAccount 생성 (🔐 PK 사용은 sign.ts에서만)
  const owner = getOwnerFromEnv();
  const sa = await toSimple7702SmartAccount({
    client: publicClient,
    owner,
    implementation: tr.delegateAddress,
  });
  if (sa.address.toLowerCase() !== tr.accountAddress.toLowerCase()) {
    throw new Error(`sa.address(${sa.address}) != accountAddress(${tr.accountAddress})`);
  }

  // 3) Authorization 생성 (필요 시)
  if (needAuthorization) {
    if (owner.address.toLowerCase() !== tr.accountAddress.toLowerCase()) {
      throw new Error("OWNER_PRIVATE_KEY address != accountAddress (sender)");
    }
    const chainId = await publicClient.getChainId();
    const nonce = await publicClient.getTransactionCount({ address: owner.address, blockTag: "latest" });

    const walletClient = createWalletClient({ account: owner, chain, transport: http(process.env.RPC_URL!) });
    const auth = await walletClient.signAuthorization({
      address: tr.delegateAddress as HexLike,
      chainId,
      nonce,
    });

    tr.needAuthorization = true;
    tr.authorization = {
      address: auth.address,
      chainId,
      nonce,
      r: auth.r,
      s: auth.s,
      yParity: auth.yParity,
    };
  } else {
    tr.needAuthorization = false;
    delete tr.authorization;
  }

  const entryPoint = ENTRYPOINT_V08;
  const calls = tr.calls.map((c: any) => ({
    to: c.to as HexLike,
    value: BigInt(c.value),
    data: c.data as HexLike,
  }));

  // 4) 가스/수수료 & PM
  const { maxFeePerGas, maxPriorityFeePerGas } = await getFeesL2Safe();
  const paymaster = tr.paymasterUrl ? createPaymaster(tr.paymasterUrl) : undefined;

  // 5) estimate
  let gasEst: UoGas | undefined;
  try {
    const estParams: any = {
      account: sa,
      calls, entryPoint,
      maxFeePerGas, maxPriorityFeePerGas,
    };
    if (tr.needAuthorization && tr.authorization) estParams.authorization = tr.authorization;
    if (paymaster) { estParams.paymaster = paymaster; estParams.paymasterContext = tr.paymasterContext; }

    gasEst = await (commonClient as any).estimateUserOperationGas(estParams);
  } catch (e: any) {
    console.warn("[estimate] failed:", e?.shortMessage || e?.message);
  }

  const callGasLimit = bump(gasEst?.callGasLimit, 130n);
  const verificationGasLimit = bump(gasEst?.verificationGasLimit, 130n);
  const preVerificationGas = bump(gasEst?.preVerificationGas, 130n);

  // 6) prepare (서명 전 UO 생성)
  const prepareParams: any = {
    account: sa,
    calls, entryPoint,
    maxFeePerGas, maxPriorityFeePerGas,
    callGasLimit, verificationGasLimit, preVerificationGas,
  };
  if (tr.needAuthorization && tr.authorization) prepareParams.authorization = tr.authorization;
  if (paymaster) { prepareParams.paymaster = paymaster; prepareParams.paymasterContext = tr.paymasterContext; }

  const unsignedAny = await prepareUserOperationCompat((commonClient as any), prepareParams);

  // ✅ 서명 전에 v0.6 형태로 필수 bytes 필드 채우기
  const uoForSign: any = (() => {
    const u = { ...unsignedAny } as any;
    // bytes 기본값
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
    u.signature = "0x" as HexLike; // 👈 반드시 세팅

    // 숫자 -> bigint
    u.nonce = BigInt(u.nonce ?? 0n);
    u.callGasLimit = BigInt(u.callGasLimit ?? 0n);
    u.verificationGasLimit = BigInt(u.verificationGasLimit ?? 0n);
    u.preVerificationGas = BigInt(u.preVerificationGas ?? 0n);
    u.maxFeePerGas = BigInt(u.maxFeePerGas ?? 0n);
    u.maxPriorityFeePerGas = BigInt(u.maxPriorityFeePerGas ?? 0n);
    return u;
  })();

  // 7) 서명 — SmartAccount가 7702 authorization 반영하여 서명
  if (typeof (sa as any).signUserOperation !== "function") {
    throw new Error("SmartAccount.signUserOperation not found. Please update viem/account-abstraction.");
  }
  const signature: `0x${string}` = await (sa as any).signUserOperation({
    entryPoint,
    userOperation: uoForSign,
    ...(tr.needAuthorization && tr.authorization ? { authorization: tr.authorization } : {}),
  });

  // 8) 저장용(모든 숫자 -> 0x 문자열)
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
    entryPoint,
    paymasterUrl: tr.paymasterUrl,
    paymasterContext: tr.paymasterContext,
    needAuthorization: tr.needAuthorization,
    authorization: tr.authorization,
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
