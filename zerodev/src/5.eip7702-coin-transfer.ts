import * as dotenv from "dotenv";
dotenv.config();
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { getEntryPoint, KERNEL_V3_1, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createPublicClient, Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
  getUserOperationGasPrice,
} from "@zerodev/sdk";

const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_V3_3;

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

  const eip7702Account = privateKeyToAccount(formattedPrivateKey as Hex);

  console.log("Signer Address:", eip7702Account.address);

  // ZeroDev 스마트 월렛 생성
  // createKernelAccount 함수를 사용하여 스마트 월렛을 생성
  const account = await createKernelAccount(publicClient, {
    eip7702Account,
    entryPoint,
    kernelVersion,
  });

  console.log("Smart Wallet Address:", account.address);

  const paymasterClient = createZeroDevPaymasterClient({
    chain: baseSepolia,
    transport: http("https://rpc.zerodev.app/api/v3/62c71a65-b635-447a-95ed-3094484c89d8/chain/84532"),
  });

  // ZeroDev 스마트 월렛 클라이언트 생성
  // createKernelAccountClient 함수를 사용하여 스마트 월렛 클라이언트를 생성
  const kernelClient = createKernelAccountClient({
    account,
    chain: baseSepolia,
    bundlerTransport: http("https://rpc.zerodev.app/api/v3/62c71a65-b635-447a-95ed-3094484c89d8/chain/84532"),
    client: publicClient,
    paymaster: paymasterClient,
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => {
        return getUserOperationGasPrice(bundlerClient);
      },
    },

    // Optional -- paymaster 사용할시
    // paymaster: {
    //   getPaymasterData(userOperation) {
    //     return paymasterClient.sponsorUserOperation({ userOperation });
    //   },
    // },
  });

  console.log("Kernel Client Address:", kernelClient.account.address);

  const checkNativeBalance = await publicClient.getBalance({ address: kernelClient.account.address });

  console.log("Native Balance:", checkNativeBalance);

  const AMOUNT = 1n * 10n ** 14n; // 0.0001 ETH

  console.log("Kernel Client Address:", kernelClient.account.address);

  const txnHash = await kernelClient.sendTransaction({
    to: "0x636f2433e640EcbC043d1AA2F6F42ff240441cd9",
    value: AMOUNT,
    data: "0x",
  });

  console.log("Transaction Hash:", txnHash);

  const afterCheckNativeBalance = await publicClient.getBalance({ address: kernelClient.account.address });

  console.log("Native Balance:", afterCheckNativeBalance);
}

smartWallet();
