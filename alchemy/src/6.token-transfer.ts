import * as dotenv from "dotenv";
dotenv.config();
import { createSmartWalletClient } from "@account-kit/wallet-client";
import { alchemy, baseSepolia } from "@account-kit/infra";
import { LocalAccountSigner } from "@aa-sdk/core";
import { createPublicClient, encodeFunctionData, zeroAddress } from "viem";

async function checkStatus() {
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

  const transport = alchemy({
    apiKey: alchemyApiKey,
  });

  const baseClient = createSmartWalletClient({
    transport,
    chain: baseSepolia,
    signer,
    mode: "local",
  });

  const status = await baseClient.getCallsStatus(
    "0x0000000000000000000000000000000000000000000000000000000000014a3455b2d9ceeb5440ebe25a05d140dff9224e78d892a4aaea82a51747e6e2920774",
  );

  console.log("Transaction Status:", status);
}

async function tokenTransfer() {
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
    args: ["0x636f2433e640EcbC043d1AA2F6F42ff240441cd9", AMOUNT],
  });

  const preparedCalls = await baseClient.prepareCalls({
    calls: [{ to: TOKEN, value: "0x0", data }],
    from: baseAddress,
    capabilities: {
      paymasterService: {
        policyId: GAS_MANAGER_POLICY_ID,
      },
    },
  });

  console.log("Prepared Calls:", preparedCalls);

  const signedCalls = await baseClient.signPreparedCalls(preparedCalls);
  console.log("Signed Calls:", signedCalls);

  const result = await baseClient.sendPreparedCalls(signedCalls);

  console.log("Transaction Hash:", result.preparedCallIds);

  const status = await baseClient.getCallsStatus(result.preparedCallIds[0]);

  console.log("Transaction Status:", status);
}

tokenTransfer();
// checkStatus();
