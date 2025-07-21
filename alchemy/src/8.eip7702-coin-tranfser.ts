import * as dotenv from "dotenv";
dotenv.config();
import { createModularAccountV2Client } from "@account-kit/smart-contracts";
import { alchemy, baseSepolia } from "@account-kit/infra";
import { LocalAccountSigner } from "@aa-sdk/core";
import getChain from "./utils/chain";

async function Eip7702CoinTransfer() {
  const privateKey = process.env.PRIVATE_KEY;
  const alchemyApiKey = process.env.ALCHEMY_API_KEY;
  const GAS_MANAGER_POLICY_ID = process.env.GAS_MANAGER_POLICY_ID;

  if (!privateKey || !alchemyApiKey || !GAS_MANAGER_POLICY_ID) {
    throw new Error("Missing environment variable: PRIVATE_KEY");
  }

  const formattedPrivateKey: `0x${string}` = privateKey.startsWith("0x")
    ? (privateKey as `0x${string}`)
    : `0x${privateKey}`;

  const signer = LocalAccountSigner.privateKeyToAccountSigner(formattedPrivateKey);

  console.log("Signer:", await signer.getAddress());

  const transport = alchemy({
    apiKey: alchemyApiKey,
  });

  const chain = await getChain("BASE_SEPOLIA");

  const smartAccountClient = await createModularAccountV2Client({
    mode: "7702",
    transport,
    signer,
    chain: chain,
    policyId: GAS_MANAGER_POLICY_ID,
  });

  const amountWei = 10n ** 14n; // 1e16 wei = 0.01 ETH

  console.log("Smart Account Client:", smartAccountClient.getAddress());

  const uoHash = await smartAccountClient.sendUserOperation({
    uo: {
      target: "0x636f2433e640EcbC043d1AA2F6F42ff240441cd9",
      value: amountWei,
      data: "0x",
    },
  });

  console.log("User Operation Hash:", uoHash);

  const txnHash = await smartAccountClient.waitForUserOperationTransaction(uoHash);

  console.log("Transaction Hash:", txnHash);
}

Eip7702CoinTransfer();
