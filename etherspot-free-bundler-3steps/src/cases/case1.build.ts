// src/cases/case1.build.ts
// 7702 + Free-Bundler(v0.8) + ERC20 fee + ETH transfer
import "dotenv/config";
import { encodeFunctionData, parseEther, parseUnits } from "viem";
import { publicClient } from "../client";
import { erc20Abi } from "../shared/abi";
import { envOrThrow, getEntryPointAddress, sanityLog } from "../shared/helpers";
import { saveJson, parseArgs } from "../shared/io";
import type { BuiltTR, Call } from "../shared/types";
import { isAddress } from "viem";

// create tr
// sign tr
// send tr to blockchain

type Hex = `0x${string}`;

async function main() {
  const args = parseArgs();
  const out = (args.out || "out/case1.build.json") as string;

  const forceAuth = Boolean(args.forceAuth || process.env.FORCE_AUTH);
  const ACCOUNT_ADDRESS = (args.account || process.env.ACCOUNT_ADDRESS) as Hex;
  const IMPLEMENTATION_ADDRESS = (args.impl ||
    process.env.IMPLEMENTATION_ADDRESS) as Hex;
  if (!ACCOUNT_ADDRESS)
    throw new Error("ACCOUNT_ADDRESS (or --account) is required");
  if (!IMPLEMENTATION_ADDRESS)
    throw new Error("IMPLEMENTATION_ADDRESS (or --impl) is required");

  const TO = (args.to || envOrThrow("TO")) as Hex;
  const VALUE_ETH = (args.valueEth ||
    process.env.VALUE_ETH ||
    "0.000005") as string;

  const FEE_TOKEN = (args.feeToken || envOrThrow("FEE_TOKEN_ADDRESS")) as Hex;
  const FEE_RECEIVER = (args.feeReceiver || envOrThrow("FEE_RECEIVER")) as Hex;

  // feeAmount 계산
  let feeAmount: bigint;
  if (process.env.FEE_AMOUNT || args.feeAmount) {
    feeAmount = BigInt(args.feeAmount || process.env.FEE_AMOUNT!);
  } else {
    let dec = Number(
      args.feeTokenDecimals || process.env.FEE_TOKEN_DECIMALS || "6"
    );
    if (!args.feeTokenDecimals && !process.env.FEE_TOKEN_DECIMALS) {
      try {
        dec = (await publicClient.readContract({
          abi: erc20Abi,
          address: FEE_TOKEN,
          functionName: "decimals",
        })) as number;
      } catch {}
    }
    const human = (args.feeAmountHuman ||
      process.env.FEE_AMOUNT_HUMAN ||
      "1") as string;
    feeAmount = parseUnits(human, dec);
  }

  const feeBal = (await publicClient.readContract({
    abi: erc20Abi,
    address: FEE_TOKEN,
    functionName: "balanceOf",
    args: [ACCOUNT_ADDRESS],
  })) as bigint;

  if (feeBal < feeAmount) {
    throw new Error(
      `[ERC20 balance insufficient] have=${feeBal.toString()} need=${feeAmount.toString()} ` +
        `(token=${FEE_TOKEN}, sender=${ACCOUNT_ADDRESS}). ` +
        `환경변수 FEE_AMOUNT_HUMAN을 줄이거나, 해당 토큰을 더 충전하세요.`
    );
  }

  await sanityLog();

  // 7702 위임 여부 확인 (0xef0100 + impl 프리픽스)
  const code = await publicClient.getCode({ address: ACCOUNT_ADDRESS });
  const expectedPrefix = `0xef0100${IMPLEMENTATION_ADDRESS.toLowerCase().slice(
    2
  )}` as Hex;
  const alreadyDelegated =
    typeof code === "string" &&
    code.length >= expectedPrefix.length &&
    code.toLowerCase().startsWith(expectedPrefix.toLowerCase());
  const needAuth = !alreadyDelegated;

  // calls: [ERC20 fee -> ETH transfer]
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
  const entryPointHint = await getEntryPointAddress();

  const outData: BuiltTR = {
    caseId: 1,
    chainId,
    accountAddress: ACCOUNT_ADDRESS,
    delegateAddress: IMPLEMENTATION_ADDRESS,
    entryPointHint,
    calls,
    paymasterUrl: process.env.PAYMASTER_URL,
    paymasterContext: process.env.PAYMASTER_CONTEXT
      ? JSON.parse(process.env.PAYMASTER_CONTEXT)
      : undefined,
    notes: "Case1: ERC20 fee + ETH transfer",
    needAuthorization: forceAuth ? true : needAuth,
  };

  saveJson(out, outData);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
