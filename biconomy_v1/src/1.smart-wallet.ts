import * as dotenv from "dotenv";
dotenv.config();
import { Hex, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygonAmoy } from "viem/chains";
import { createSmartAccountClient } from "@biconomy/account";

async function initializeNetwork() {
  const network = "BNB";

  const privateKey = process.env.PRIVATE_KEY;
  const bundlerUrl = process.env[`BICONOMY_${network}_BUNDLER_URL`];
  const biconomyApiKey = process.env[`BICONOMY_${network}_API_KEY`];
  const rpcUrl = process.env[`${network}_RPC_URL`];

  if (!privateKey || !bundlerUrl || !biconomyApiKey || !rpcUrl) {
    throw new Error("Missing environment variables");
  }

  const account = privateKeyToAccount(privateKey as Hex);

  const client = createWalletClient({
    account,
    chain: polygonAmoy,
    transport: http(),
  });
  const eoa = client.account.address;
  console.log(`EOA address: ${eoa}`);

  const smartAccount = await createSmartAccountClient({
    signer: client,
    bundlerUrl: "",
    biconomyPaymasterApiKey: "",
  });
  const smartAccountAddress = await smartAccount.getAccountAddress();

  console.log(smartAccountAddress);
}

initializeNetwork();
