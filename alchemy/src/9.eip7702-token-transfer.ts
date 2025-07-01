import * as dotenv from "dotenv";
dotenv.config();
import { createModularAccountV2Client } from "@account-kit/smart-contracts";
import { alchemy, arbitrumSepolia, baseSepolia } from "@account-kit/infra";
import { LocalAccountSigner } from "@aa-sdk/core";
import { createPublicClient, encodeFunctionData, erc20Abi, zeroAddress } from "viem";

async function Eip7702TokenTransfer() {
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

  const smartAccountClient = await createModularAccountV2Client({
    mode: "7702",
    transport,
    signer,
    chain: baseSepolia,
    policyId: GAS_MANAGER_POLICY_ID,
  });

  console.log("Smart Account Client:", smartAccountClient.getAddress());

  const AMOUNT = 1n * 10n ** BigInt(6);
  const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

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
    args: ["0x60695a986198F1beAeD2dd77bC1Df80D487EB1D5", AMOUNT],
  });

  const uoHash = await smartAccountClient.sendUserOperation({
    uo: {
      target: TOKEN,
      value: 0n,
      data: data,
    },
  });

  console.log("User Operation Hash:", uoHash);

  const txnHash = await smartAccountClient.waitForUserOperationTransaction(uoHash);

  console.log("Transaction Hash:", txnHash);
}

Eip7702TokenTransfer();
