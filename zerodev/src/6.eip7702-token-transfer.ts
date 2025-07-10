import * as dotenv from "dotenv";
dotenv.config();
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { getEntryPoint, KERNEL_V3_1, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { createPublicClient, encodeFunctionData, Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
  getUserOperationGasPrice,
} from "@zerodev/sdk";
import { getChain, getChainId } from "./utils/chain";

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

  const chain = await getChain("ARBITRUM_SEPOLIA");
  const chainId = await getChainId("ARBITRUM_SEPOLIA");

  const publicClient = createPublicClient({
    transport: http(),
    chain: chain,
  });

  const eip7702Account = privateKeyToAccount(formattedPrivateKey as Hex);

  // ZeroDev 스마트 월렛 생성
  // createKernelAccount 함수를 사용하여 스마트 월렛을 생성
  const account = await createKernelAccount(publicClient, {
    eip7702Account,
    entryPoint,
    kernelVersion,
  });

  const paymasterClient = createZeroDevPaymasterClient({
    chain: chain,
    transport: http(`https://rpc.zerodev.app/api/v3/62c71a65-b635-447a-95ed-3094484c89d8/chain/${chainId}`),
  });

  // ZeroDev 스마트 월렛 클라이언트 생성
  // createKernelAccountClient 함수를 사용하여 스마트 월렛 클라이언트를 생성
  const kernelClient = createKernelAccountClient({
    account,
    chain: chain,
    bundlerTransport: http(`https://rpc.zerodev.app/api/v3/62c71a65-b635-447a-95ed-3094484c89d8/chain/${chainId}`),
    client: publicClient,
    paymaster: paymasterClient,
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => {
        return getUserOperationGasPrice(bundlerClient);
      },
    },
  });

  const AMOUNT = 1n * 10n ** BigInt(5);
  const TOKEN = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";

  console.log("Kernel Client Address:", kernelClient.account.address);

  const data = encodeFunctionData({
    abi: [
      {
        name: "transfer",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "recipient", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "success", type: "bool" }],
      },
    ],
    functionName: "transfer",
    args: ["0x636f2433e640EcbC043d1AA2F6F42ff240441cd9", AMOUNT],
  });

  const txnHash = await kernelClient.sendTransaction({
    to: TOKEN,
    value: 0n,
    data: data,
  });

  console.log("Transaction Hash:", txnHash);
}

smartWallet();
