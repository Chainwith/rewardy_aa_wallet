import * as dotenv from "dotenv";
dotenv.config();
import { createSmartWalletClient } from "@account-kit/wallet-client";
import { alchemy, arbitrumSepolia, baseSepolia } from "@account-kit/infra";
import { LocalAccountSigner } from "@aa-sdk/core";
import { createPublicClient } from "viem";

async function signTypedData() {
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

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: transport,
  });

  const typedData = {
    domain: {
      name: "Rewardy",
      version: "1",
      chainId: baseSepolia.id,
      verifyingContract: "0xE1dcA3e0127e6E1A9e322607e71ae77cF6871ac4",
    },
    types: {
      Test: [
        { name: "nonce", type: "uint256" },
        { name: "sender", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    primaryType: "Test",
    message: {
      nonce: 1,
      sender: baseAddress,
      amount: 500,
    },
  } as const;

  const signature = await baseClient.signTypedData(typedData);

  console.log("Signature:", signature);

  const isValid = await publicClient.verifyTypedData({
    address: baseAddress,
    ...typedData,
    signature,
  });

  console.log("Is valid signature:", isValid);
  // true : 성공
}

signTypedData();
