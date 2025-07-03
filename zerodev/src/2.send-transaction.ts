import * as dotenv from "dotenv";
dotenv.config();
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { createPublicClient, Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";

const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_V3_1;

async function coinTransfer() {
  const privateKey = process.env.PRIVATE_KEY;

  if (!privateKey) {
    throw new Error("Missing environment variable: PRIVATE_KEY");
  }

  const formattedPrivateKey: `0x${string}` = privateKey.startsWith("0x")
    ? (privateKey as `0x${string}`)
    : `0x${privateKey}`;

  const publicClient = createPublicClient({
    transport: http(),
    chain: baseSepolia,
  });

  const signer = privateKeyToAccount(formattedPrivateKey as Hex);

  console.log("Signer Address:", signer.address);

  // ECDSA Validator 생성
  // ECDSA Validator는 ZeroDev의 스마트 월렛을 위한 서명자 역할
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer,
    entryPoint,
    kernelVersion,
  });

  const account = await createKernelAccount(publicClient, {
    plugins: {
      sudo: ecdsaValidator,
    },
    entryPoint,
    kernelVersion,
  });

  const kernelClient = createKernelAccountClient({
    account,
    chain: baseSepolia,
    bundlerTransport: http("https://rpc.zerodev.app/api/v3/62c71a65-b635-447a-95ed-3094484c89d8/chain/84532"),
    client: publicClient,
  });

  const AMOUNT = 1n * 10n ** 14n; // 0.0001 ETH

  console.log("Kernel Client Address:", kernelClient.account.address);

  const txnHash = await kernelClient.sendTransaction({
    to: "0x60695a986198F1beAeD2dd77bC1Df80D487EB1D5",
    value: AMOUNT,
    data: "0x",
  });

  console.log("Transaction Hash:", txnHash);
}

coinTransfer();
