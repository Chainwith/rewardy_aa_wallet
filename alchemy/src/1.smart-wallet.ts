import * as dotenv from "dotenv";
dotenv.config();
import { createSmartWalletClient } from "@account-kit/wallet-client";
import { alchemy, arbitrumSepolia, baseSepolia } from "@account-kit/infra";
import { LocalAccountSigner } from "@aa-sdk/core";
import { createPublicClient, erc20Abi } from "viem";

async function createSmartAccountClient() {
  const privateKey = process.env.PRIVATE_KEY;
  const alchemyApiKey = process.env.ALCHEMY_API_KEY;

  if (!privateKey || !alchemyApiKey) {
    throw new Error("Missing environment variable: PRIVATE_KEY");
  }

  const formattedPrivateKey: `0x${string}` = privateKey.startsWith("0x")
    ? (privateKey as `0x${string}`)
    : `0x${privateKey}`;

  const signer = LocalAccountSigner.privateKeyToAccountSigner(formattedPrivateKey);
  console.log("Signer:", signer);

  const transport = alchemy({
    apiKey: alchemyApiKey,
  });

  const baseClient = createSmartWalletClient({
    transport,
    chain: baseSepolia,
    signer,
    mode: "local",
  });

  const arbitrumClient = createSmartWalletClient({
    transport,
    chain: arbitrumSepolia,
    signer,
    mode: "local",
  });

  const baseAccount = await baseClient.requestAccount();
  const baseAddress = baseAccount.address;

  const arbitrumAccount = await arbitrumClient.requestAccount();
  const arbitrumAddress = arbitrumAccount.address;

  console.log("Smart Account Base Address:", baseAddress);
  console.log("Smart Account Arbitrum Address:", arbitrumAddress);

  // 같은 Smart Account Address 나옴

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: transport,
  });

  // balance 확인
  const nativeBalance = await publicClient.getBalance({ address: baseAddress });

  console.log("Base Sepolia Native Balance:", nativeBalance);

  const tokenBalance = await publicClient.readContract({
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // usdc contract address
    abi: erc20Abi,
    functionName: "balanceOf",
    args: ["0x636f2433e640EcbC043d1AA2F6F42ff240441cd9"], // user address
  });

  console.log("Token Balance:", tokenBalance);
}

createSmartAccountClient();
