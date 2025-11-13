// build.ts
import "dotenv/config";
import { encodeFunctionData, parseEther, parseUnits } from "viem";
import { publicClient } from "../client";
import { erc20Abi } from "../shared/abi";
import { envOrThrow, getEntryPointAddress, sanityLog } from "../shared/helpers";
import { saveJson, parseArgs } from "../shared/io";
import type { BuiltTR, Call } from "../shared/types";

type Hex = `0x${string}`;

async function main() {
  const args = parseArgs();
  const out = (args.out || "out/case0.build.json") as string;

  // ✅ build 단계에서 PK 없이 주소만 받음
  const ACCOUNT_ADDRESS = (args.account || process.env.ACCOUNT_ADDRESS) as Hex;
  const IMPLEMENTATION_ADDRESS = (args.impl || process.env.IMPLEMENTATION_ADDRESS) as Hex;
  if (!ACCOUNT_ADDRESS) throw new Error("ACCOUNT_ADDRESS (or --account) is required");
  if (!IMPLEMENTATION_ADDRESS) throw new Error("IMPLEMENTATION_ADDRESS (or --impl) is required");

  // 전송 대상 / 수수료 파라미터 (env 우선, CLI로도 덮어쓰기 가능)
  const TO = (args.to || envOrThrow("TO")) as Hex;
  const VALUE_ETH = (args.valueEth || process.env.VALUE_ETH || "0.000005") as string;

  const FEE_TOKEN = (args.feeToken || envOrThrow("FEE_TOKEN_ADDRESS")) as Hex;
  const FEE_RECEIVER = (args.feeReceiver || envOrThrow("FEE_RECEIVER")) as Hex;

  // === 수수료 토큰 수량 계산 ===
  // 1) FEE_AMOUNT(기저단위, raw bigint 문자열) 가 있으면 그대로 사용
  // 2) 없으면 FEE_AMOUNT_HUMAN(+decimals) 기준으로 parse
  let feeAmount: bigint;
  if (process.env.FEE_AMOUNT || args.feeAmount) {
    feeAmount = BigInt(args.feeAmount || process.env.FEE_AMOUNT!);
  } else {
    let dec = Number(args.feeTokenDecimals || process.env.FEE_TOKEN_DECIMALS || "6");
    if (!args.feeTokenDecimals && !process.env.FEE_TOKEN_DECIMALS) {
      try {
        dec = (await publicClient.readContract({
          abi: erc20Abi,
          address: FEE_TOKEN,
          functionName: "decimals",
        })) as number;
      } catch {
        // 읽기 실패 시 env 기본값(6) 사용
      }
    }
    const human = (args.feeAmountHuman || process.env.FEE_AMOUNT_HUMAN || "1") as string;
    feeAmount = parseUnits(human, dec);
  }

  await sanityLog();

  // ✅ on-chain code 조회로 delegation 여부 판단 (EIP-7702 코드: 0xef0100 + impl)
  const code = await publicClient.getCode({ address: ACCOUNT_ADDRESS });
  const expectedPrefix = (`0xef0100${IMPLEMENTATION_ADDRESS.toLowerCase().slice(2)}`) as Hex;
  const alreadyDelegated =
    typeof code === "string" &&
    code.length >= expectedPrefix.length &&
    code.toLowerCase().startsWith(expectedPrefix.toLowerCase());
  const needAuth = !alreadyDelegated;

  // === calls 구성: [ ERC20 fee -> ETH transfer ] ===
  const feeCall: Call = {
    to: FEE_TOKEN,
    value: "0",
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [FEE_RECEIVER, feeAmount],
    }) as Hex,
  };

  const ethCall: Call = {
    to: TO,
    value: parseEther(VALUE_ETH).toString(),
    data: "0x" as Hex,
  };

  const calls: Call[] = [feeCall, ethCall];

  const chainId = await publicClient.getChainId();
  const entryPointHint = await getEntryPointAddress(); // 참고용 힌트 (send.ts는 v0.8 고정 사용)

  const outData: BuiltTR = {
    caseId: 1,
    chainId,
    accountAddress: ACCOUNT_ADDRESS,         // 소유자 EOA (= 7702 Account 주소)
    delegateAddress: IMPLEMENTATION_ADDRESS, // 7702 구현 주소
    entryPointHint,
    calls,
    paymasterUrl: process.env.PAYMASTER_URL,
    paymasterContext: process.env.PAYMASTER_CONTEXT
      ? JSON.parse(process.env.PAYMASTER_CONTEXT)
      : undefined,
    notes: "Case1: ERC20 fee + ETH transfer (build without PK)",
    needAuthorization: needAuth,             // sign/send에서 이 플래그로 분기
  };

  saveJson(out, outData);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
