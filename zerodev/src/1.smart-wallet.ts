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

async function smartWallet() {
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

  console.log("ECDSA Validator Address:", ecdsaValidator);

  // ZeroDev 스마트 월렛 생성
  // createKernelAccount 함수를 사용하여 스마트 월렛을 생성
  const account = await createKernelAccount(publicClient, {
    plugins: {
      sudo: ecdsaValidator,
    },
    entryPoint,
    kernelVersion,
  });

  console.log("Smart Wallet Address:", account.address);

  // ZeroDev 스마트 월렛 클라이언트 생성
  // createKernelAccountClient 함수를 사용하여 스마트 월렛 클라이언트를 생성
  const kernelClient = createKernelAccountClient({
    account,
    chain: baseSepolia,
    bundlerTransport: http("https://rpc.zerodev.app/api/v3/62c71a65-b635-447a-95ed-3094484c89d8/chain/84532"),
    client: publicClient,

    // Optional -- paymaster 사용할시
    // paymaster: {
    //   getPaymasterData(userOperation) {
    //     return paymasterClient.sponsorUserOperation({ userOperation });
    //   },
    // },
  });

  console.log("Kernel Client Address:", kernelClient.account.address);
}

smartWallet();
