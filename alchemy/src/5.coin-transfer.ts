import * as dotenv from "dotenv";
dotenv.config();
import { createSmartWalletClient } from "@account-kit/wallet-client";
import { alchemy, arbitrumSepolia, baseSepolia } from "@account-kit/infra";
import { LocalAccountSigner } from "@aa-sdk/core";
import { createPublicClient, zeroAddress } from "viem";

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

async function coinTransfer() {
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

  const amountInEther = "0.0001";
  const amount = BigInt(Number(amountInEther) * 1e18).toString(16);

  const preparedCalls = await baseClient.prepareCalls({
    calls: [{ to: "0x60695a986198F1beAeD2dd77bC1Df80D487EB1D5", value: `0x${amount}` }],
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

coinTransfer();
// checkStatus();
