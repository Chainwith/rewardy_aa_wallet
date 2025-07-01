import * as dotenv from "dotenv";
dotenv.config();
import { createSmartWalletClient } from "@account-kit/wallet-client";
import { alchemy, arbitrumSepolia, baseSepolia } from "@account-kit/infra";
import { LocalAccountSigner } from "@aa-sdk/core";
import { createPublicClient } from "viem";

async function signMessage() {
  const privateKey = process.env.PRIVATE_KEY;
  const alchemyApiKey = process.env.ALCHEMY_API_KEY;

  if (!privateKey || !alchemyApiKey) {
    throw new Error("Missing environment variable: PRIVATE_KEY");
  }

  const formattedPrivateKey: `0x${string}` = privateKey.startsWith("0x")
    ? (privateKey as `0x${string}`)
    : `0x${privateKey}`;

  const signer = LocalAccountSigner.privateKeyToAccountSigner(formattedPrivateKey);

  const transport = alchemy({
    apiKey: alchemyApiKey,
  });

  const baseClient = createSmartWalletClient({
    transport,
    chain: baseSepolia,
    signer,
    mode: "local",
  });

  const baseAccount = await baseClient.requestAccount();
  const baseAddress = baseAccount.address;

  console.log("Smart Account Base Address:", baseAddress);

  const message = "we are so back";
  const signature = await baseClient.signMessage({ message });

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: transport,
  });

  const isValid = await publicClient.verifyMessage({
    address: baseAddress,
    message,
    signature,
  });

  console.log("Signature:", signature);
  console.log("Is valid signature:", isValid);
}

signMessage();
