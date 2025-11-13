// src/cases/case4.build.ts
// 7702 + Free-Bundler(v0.8) + ETH transfer (no extra fee)
import "dotenv/config";
import { parseEther } from "viem";
import { publicClient } from "../client";
import { envOrThrow, getEntryPointAddress, sanityLog } from "../shared/helpers";
import { saveJson, parseArgs } from "../shared/io";
import type { BuiltTR, Call } from "../shared/types";

type Hex = `0x${string}`;

async function main() {
  const args = parseArgs();
  const out = (args.out || "out/case4.build.json") as string;

  const forceAuth = Boolean(args.forceAuth || process.env.FORCE_AUTH);
  const ACCOUNT_ADDRESS = (args.account || process.env.ACCOUNT_ADDRESS) as Hex;
  const IMPLEMENTATION_ADDRESS = (args.impl || process.env.IMPLEMENTATION_ADDRESS) as Hex;
  if (!ACCOUNT_ADDRESS) throw new Error("ACCOUNT_ADDRESS (or --account) is required");
  if (!IMPLEMENTATION_ADDRESS) throw new Error("IMPLEMENTATION_ADDRESS (or --impl) is required");

  const TO = (args.to || envOrThrow("TO")) as Hex;
  const VALUE_ETH = (args.valueEth || process.env.VALUE_ETH || "0.001") as string;

  await sanityLog();

  const code = await publicClient.getCode({ address: ACCOUNT_ADDRESS });
  const expectedPrefix = (`0xef0100${IMPLEMENTATION_ADDRESS.toLowerCase().slice(2)}`) as Hex;
  const alreadyDelegated =
    typeof code === "string" &&
    code.length >= expectedPrefix.length &&
    code.toLowerCase().startsWith(expectedPrefix.toLowerCase());
  const needAuth = !alreadyDelegated;

  const ethCall: Call = { to: TO, value: parseEther(VALUE_ETH).toString(), data: "0x" as Hex };
  const calls: Call[] = [ethCall];

  const chainId = await publicClient.getChainId();
  const entryPointHint = await getEntryPointAddress();

  const outData: BuiltTR = {
    caseId: 3, chainId,
    accountAddress: ACCOUNT_ADDRESS,
    delegateAddress: IMPLEMENTATION_ADDRESS,
    entryPointHint,
    calls,
    paymasterUrl: process.env.PAYMASTER_URL,
    paymasterContext: process.env.PAYMASTER_CONTEXT ? JSON.parse(process.env.PAYMASTER_CONTEXT) : undefined,
    notes: "Case4: ETH transfer only",
    needAuthorization: forceAuth ? true : needAuth,
  };
  saveJson(out, outData);
}
main().catch((e) => { console.error(e); process.exit(1); });
