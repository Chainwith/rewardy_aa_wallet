import * as dotenv from "dotenv";
dotenv.config();

import { createPublicClient, Hex, http, parseEther, zeroAddress } from "viem";
import { createSmartAccountClient, getRequiredPrefund } from "permissionless";
import { toSimple7702SmartAccount } from "viem/account-abstraction";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { privateKeyToAccount } from "viem/accounts";
import getChain from "./utils/chain";

async function sendTransactionTest() {
  const privateKey = process.env.PRIVATE_KEY as `0x${string}`;

  const eoa7702 = privateKeyToAccount(privateKey);

  const chain = await getChain("SEPOLIA");

  const client = createPublicClient({
    chain: chain.chainConfig,
    transport: http(chain.chainOrg),
    // transport: http(`https://base-sepolia.drpc.org`),
  });

  const simple7702Account = await toSimple7702SmartAccount({
    client,
    owner: eoa7702,
  });

  const pimlicoClient = createPimlicoClient({
    chain: chain.chainConfig,
    transport: http(`https://api.pimlico.io/v2/${chain.chainId}/rpc?apikey=${process.env.PIMLICO_API_KEY}`),
    // transport: http(`https://api.pimlico.io/v2/84532/rpc?apikey=${process.env.PIMLICO_API_KEY}`),
  });

  const smartAccountClient = createSmartAccountClient({
    client,
    chain: chain.chainConfig,
    account: simple7702Account,
    paymaster: pimlicoClient,
    bundlerTransport: http(`https://api.pimlico.io/v2/${chain.chainId}/rpc?apikey=${process.env.PIMLICO_API_KEY}`),
    // bundlerTransport: http(`https://api.pimlico.io/v2/84532/rpc?apikey=${process.env.PIMLICO_API_KEY}`),
    userOperation: {
      estimateFeesPerGas: async () => {
        return (await pimlicoClient.getUserOperationGasPrice()).standard;
      },
    },
  });

  const isSmartAccountDeployed = await smartAccountClient.account.isDeployed();

  console.log("Smart Account Deployed:", isSmartAccountDeployed);

  const transactionHash = await smartAccountClient.sendTransaction({
    to: "0x636f2433e640EcbC043d1AA2F6F42ff240441cd9",
    value: parseEther("0.0001"),
    data: "0x",
  });

  console.log("Transaction Hash:", transactionHash);
}

sendTransactionTest();
