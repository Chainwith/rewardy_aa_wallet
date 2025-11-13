// 7702 + Free-Bundler(v0.8) + ERC20 transfer (no extra fee)
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
  const out = (args.out || "out/case2.build.json") as string;

  const forceAuth = Boolean(args.forceAuth || process.env.FORCE_AUTH);
  const ACCOUNT_ADDRESS = (args.account || process.env.ACCOUNT_ADDRESS) as Hex;
  const IMPLEMENTATION_ADDRESS = (args.impl || process.env.IMPLEMENTATION_ADDRESS) as Hex;
  if (!ACCOUNT_ADDRESS) throw new Error("ACCOUNT_ADDRESS (or --account) is required");
  if (!IMPLEMENTATION_ADDRESS) throw new Error("IMPLEMENTATION_ADDRESS (or --impl) is required");

  const TOKEN = (args.token || envOrThrow("TOKEN_ADDRESS")) as Hex;
  const TOKEN_TO = (args.to || envOrThrow("TOKEN_TO")) as Hex;

  // amount 결정
  let amount: bigint;
  if (process.env.TOKEN_AMOUNT || args.tokenAmount) {
    amount = BigInt(args.tokenAmount || process.env.TOKEN_AMOUNT!);
  } else {
    let dec = Number(args.tokenDecimals || process.env.TOKEN_DECIMALS || "18");
    if (!args.tokenDecimals && !process.env.TOKEN_DECIMALS) {
      try {
        dec = (await publicClient.readContract({ abi: erc20Abi, address: TOKEN, functionName: "decimals" })) as number;
      } catch {}
    }
    const human = (args.tokenAmountHuman || process.env.TOKEN_AMOUNT_HUMAN || "1") as string;
    amount = parseUnits(human, dec);
  }

  await sanityLog();

  // 7702 위임 여부 확인
  const code = await publicClient.getCode({ address: ACCOUNT_ADDRESS });
  const expectedPrefix = (`0xef0100${IMPLEMENTATION_ADDRESS.toLowerCase().slice(2)}`) as Hex;
  const alreadyDelegated = typeof code === "string" && code.length >= expectedPrefix.length
    && code.toLowerCase().startsWith(expectedPrefix.toLowerCase());
  const needAuth = !alreadyDelegated;

  // calls
  const tokenTransfer: Call = {
    to: TOKEN, value: "0",
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [TOKEN_TO, amount] }) as Hex,
  };
  const calls: Call[] = [tokenTransfer];

  const chainId = await publicClient.getChainId();
  const entryPointHint = await getEntryPointAddress();

  const outData: BuiltTR = {
    caseId: 2, chainId,
    accountAddress: ACCOUNT_ADDRESS,
    delegateAddress: IMPLEMENTATION_ADDRESS,
    entryPointHint,
    calls,
    paymasterUrl: process.env.PAYMASTER_URL,
    paymasterContext: process.env.PAYMASTER_CONTEXT ? JSON.parse(process.env.PAYMASTER_CONTEXT) : undefined,
    notes: "Case2: ERC20 transfer only (type:4)",
    needAuthorization: forceAuth ? true : needAuth,
  };

  saveJson(out, outData);
}
main().catch((e) => { console.error(e); process.exit(1); });
