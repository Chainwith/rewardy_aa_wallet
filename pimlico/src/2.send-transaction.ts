import * as dotenv from "dotenv";
dotenv.config();

import { createPublicClient, Hex, http, parseEther, zeroAddress } from "viem";
import { createSmartAccountClient, getRequiredPrefund } from "permissionless";
import { entryPoint07Address, getUserOperation, toSimple7702SmartAccount } from "viem/account-abstraction";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";

async function sendTransactionTest() {
  const privateKey = process.env.PRIVATE_KEY as `0x${string}`;

  const eoa7702 = privateKeyToAccount(privateKey);

  const client = createPublicClient({
    chain: sepolia,
    transport: http(`https://sepolia.drpc.org`),
    // transport: http(`https://base-sepolia.drpc.org`),
  });

  const simple7702Account = await toSimple7702SmartAccount({
    client,
    owner: eoa7702,
  });

  const pimlicoClient = createPimlicoClient({
    chain: sepolia,
    transport: http(`https://api.pimlico.io/v2/11155111/rpc?apikey=${process.env.PIMLICO_API_KEY}`),
    // transport: http(`https://api.pimlico.io/v2/84532/rpc?apikey=${process.env.PIMLICO_API_KEY}`),
  });

  const smartAccountClient = createSmartAccountClient({
    client,
    chain: sepolia,
    account: simple7702Account,
    paymaster: pimlicoClient,
    bundlerTransport: http(`https://api.pimlico.io/v2/11155111/rpc?apikey=${process.env.PIMLICO_API_KEY}`),
    // bundlerTransport: http(`https://api.pimlico.io/v2/84532/rpc?apikey=${process.env.PIMLICO_API_KEY}`),
    userOperation: {
      estimateFeesPerGas: async () => {
        return (await pimlicoClient.getUserOperationGasPrice()).fast;
      },
    },
  });

  const isSmartAccountDeployed = await smartAccountClient.account.isDeployed();

  console.log("Smart Account Deployed:", isSmartAccountDeployed);

  let transactionHash: Hex;

  if (!isSmartAccountDeployed) {
    transactionHash = await smartAccountClient.sendTransaction({
      to: zeroAddress,
      value: BigInt(0),
      data: "0x",
      authorization: await eoa7702.signAuthorization({
        address: "0xe6Cae83BdE06E4c305530e199D7217f42808555B",
        chainId: sepolia.id,
        nonce: await client.getTransactionCount({
          address: eoa7702.address,
        }),
      }),
    });
  } else {
    transactionHash = await smartAccountClient.sendTransaction({
      to: "0x60695a986198F1beAeD2dd77bC1Df80D487EB1D5",
      value: parseEther("0.0001"),
      data: "0x",
    });
  }

  console.log("Transaction Hash:", transactionHash);
}

sendTransactionTest();
