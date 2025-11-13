import "dotenv/config";
import { http, createWalletClient } from "viem";
import { chain, publicClient } from "../client";
import { getOwnerFromEnv } from "../account";
import { loadJson, saveJson, parseArgs } from "../shared/io";
import type { BuiltTR } from "../shared/types";

type Hex = `0x${string}`;

async function main() {
  const args = parseArgs();
  const input = args.in || "out/case4.build.json";
  const output = args.out || "out/case4.signed.json";
  const forceAuth = Boolean(args.forceAuth || process.env.FORCE_AUTH);

  const built = loadJson<BuiltTR>(input);
  const tr: any = { ...built };

  const senderCode = await publicClient.getCode({ address: tr.accountAddress as Hex });
  const expectedPrefix = `0xef0100${tr.delegateAddress.toLowerCase().slice(2)}` as Hex;
  const alreadyDelegated = typeof senderCode === "string" && senderCode.length >= expectedPrefix.length
    && senderCode.toLowerCase().startsWith(expectedPrefix.toLowerCase());

  if (!alreadyDelegated || forceAuth) {
    const owner = getOwnerFromEnv();
    if (owner.address.toLowerCase() !== tr.accountAddress.toLowerCase()) {
      throw new Error("OWNER_PRIVATE_KEY address != accountAddress (sender)");
    }
    const chainId = await publicClient.getChainId();
    const nonce = await publicClient.getTransactionCount({ address: owner.address, blockTag: "latest" });

    const walletClient = createWalletClient({ account: owner, chain, transport: http(process.env.RPC_URL!) });
    const auth = await walletClient.signAuthorization({ address: tr.delegateAddress as Hex, chainId, nonce });

    tr.needAuthorization = true;
    tr.authorization = {
      address: auth.address,
      chainId: `0x${chainId.toString(16)}`,
      nonce: `0x${BigInt(nonce).toString(16)}`,
      r: auth.r, s: auth.s, yParity: auth.yParity,
    };
  } else {
    tr.needAuthorization = false;
    delete tr.authorization;
  }

  saveJson(output, tr);
  console.log(`📝 saved: ${output}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
