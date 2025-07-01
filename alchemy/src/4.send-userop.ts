import * as dotenv from "dotenv";
dotenv.config();
import { createSmartWalletClient } from "@account-kit/wallet-client";
import { alchemy, arbitrumSepolia, baseSepolia } from "@account-kit/infra";
import { LocalAccountSigner } from "@aa-sdk/core";
import { createPublicClient, zeroAddress } from "viem";

async function sendUserOp() {
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

  const preparedCalls = await baseClient.prepareCalls({
    calls: [{ to: zeroAddress, value: "0x0" }],
    from: baseAddress,
    capabilities: {
      paymasterService: {
        policyId: GAS_MANAGER_POLICY_ID,
      },
    },
  });

  const signedCalls = await baseClient.signPreparedCalls(preparedCalls);
  console.log("Signed Calls:", signedCalls);

  const result = await baseClient.sendPreparedCalls(signedCalls);

  console.log("Transaction Hash:", result.preparedCallIds);
}

sendUserOp();
