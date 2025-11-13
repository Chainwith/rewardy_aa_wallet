// src/cases/case3.build.ts
// 7702 + Free-Bundler(v0.8) + ERC20 fee + ERC20 transfer (type:4)
import "dotenv/config";
import { encodeFunctionData, parseUnits } from "viem";
import { publicClient } from "../client";
import { erc20Abi } from "../shared/abi";
import { envOrThrow, getEntryPointAddress, sanityLog } from "../shared/helpers";
import { saveJson, parseArgs } from "../shared/io";
import type { BuiltTR, Call } from "../shared/types";

type Hex = `0x${string}`;

async function main() {
  const args = parseArgs();
  const out = (args.out || "out/case3.build.json") as string;

  const forceAuth = Boolean(args.forceAuth || process.env.FORCE_AUTH);

  // 7702 계정/구현체
  const ACCOUNT_ADDRESS = (args.account || process.env.ACCOUNT_ADDRESS) as Hex;
  const IMPLEMENTATION_ADDRESS = (args.impl || process.env.IMPLEMENTATION_ADDRESS) as Hex;
  if (!ACCOUNT_ADDRESS) throw new Error("ACCOUNT_ADDRESS (or --account) is required");
  if (!IMPLEMENTATION_ADDRESS) throw new Error("IMPLEMENTATION_ADDRESS (or --impl) is required");

  // --- 수수료(ERC20) 정보 ---
  const FEE_TOKEN = (args.feeToken || envOrThrow("FEE_TOKEN_ADDRESS")) as Hex;
  const FEE_RECEIVER = (args.feeReceiver || envOrThrow("FEE_RECEIVER")) as Hex;

  // FEE_AMOUNT: 정수(최소단위) 또는 사람이 읽는 값(human) + decimals 중 하나
  let feeAmount: bigint;
  if (process.env.FEE_AMOUNT || args.feeAmount) {
    feeAmount = BigInt(args.feeAmount || process.env.FEE_AMOUNT!);
  } else {
    // decimals 우선순위: args > env > onchain
    let feeDec = Number(args.feeTokenDecimals || process.env.FEE_TOKEN_DECIMALS || "6");
    if (!args.feeTokenDecimals && !process.env.FEE_TOKEN_DECIMALS) {
      try {
        feeDec = (await publicClient.readContract({
          abi: erc20Abi,
          address: FEE_TOKEN,
          functionName: "decimals",
        })) as number;
      } catch {}
    }
    const feeHuman = (args.feeAmountHuman || process.env.FEE_AMOUNT_HUMAN || "1") as string;
    feeAmount = parseUnits(feeHuman, feeDec);
  }

  // --- 실제 전송할 ERC20 토큰 정보 ---
  const TOKEN = (args.token || envOrThrow("TOKEN_ADDRESS")) as Hex;
  const TOKEN_TO = (args.tokenTo || envOrThrow("TOKEN_TO")) as Hex;

  let tokenAmount: bigint;
  if (process.env.TOKEN_AMOUNT || args.tokenAmount) {
    tokenAmount = BigInt(args.tokenAmount || process.env.TOKEN_AMOUNT!);
  } else {
    let tokenDec = Number(args.tokenDecimals || process.env.TOKEN_DECIMALS || "18");
    if (!args.tokenDecimals && !process.env.TOKEN_DECIMALS) {
      try {
        tokenDec = (await publicClient.readContract({
          abi: erc20Abi,
          address: TOKEN,
          functionName: "decimals",
        })) as number;
      } catch {}
    }
    const tokenHuman = (args.tokenAmountHuman || process.env.TOKEN_AMOUNT_HUMAN || "1") as string;
    tokenAmount = parseUnits(tokenHuman, tokenDec);
  }

  await sanityLog();

  // 7702 위임 여부(impl prefix 0xef0100 + impl)로 auth 필요성 판별
  const code = await publicClient.getCode({ address: ACCOUNT_ADDRESS });
  const expectedPrefix = (`0xef0100${IMPLEMENTATION_ADDRESS.toLowerCase().slice(2)}`) as Hex;
  const alreadyDelegated =
    typeof code === "string" &&
    code.length >= expectedPrefix.length &&
    code.toLowerCase().startsWith(expectedPrefix.toLowerCase());
  const needAuth = !alreadyDelegated;

  // calls: [ERC20 fee → ERC20 transfer]
  const feeCall: Call = {
    to: FEE_TOKEN,
    value: "0",
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [FEE_RECEIVER, feeAmount],
    }) as Hex,
  };

  const tokenTransferCall: Call = {
    to: TOKEN,
    value: "0",
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [TOKEN_TO, tokenAmount],
    }) as Hex,
  };

  const calls: Call[] = [feeCall, tokenTransferCall];

  const chainId = await publicClient.getChainId();
  const entryPointHint = await getEntryPointAddress();

  const outData: BuiltTR = {
    caseId: 3,
    chainId,
    accountAddress: ACCOUNT_ADDRESS,
    delegateAddress: IMPLEMENTATION_ADDRESS,
    entryPointHint,
    calls,
    paymasterUrl: process.env.PAYMASTER_URL,
    paymasterContext: process.env.PAYMASTER_CONTEXT ? JSON.parse(process.env.PAYMASTER_CONTEXT) : undefined,
    notes: "Case3: ERC20 fee + ERC20 transfer (type:4)",
    // 이미 위임되어 있으면 auth 불필요, 강제(auth) 옵션이 있으면 true
    needAuthorization: forceAuth ? true : needAuth,
  };

  saveJson(out, outData);
}
main().catch((e) => { console.error(e); process.exit(1); });
