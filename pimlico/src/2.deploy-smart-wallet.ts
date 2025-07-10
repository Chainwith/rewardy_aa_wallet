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

  console.log("EOA Address:", eoa7702.address);

  const chain = await getChain("ARBITRUM_SEPOLIA");

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
        return (await pimlicoClient.getUserOperationGasPrice()).fast;
      },
    },
  });

  const isSmartAccountDeployed = await smartAccountClient.account.isDeployed();

  console.log("Smart Account Deployed:", isSmartAccountDeployed);

  const transactionHash = await smartAccountClient.sendTransaction({
    to: zeroAddress,
    value: BigInt(0),
    data: "0x",
    authorization: await eoa7702.signAuthorization({
      address: "0xe6Cae83BdE06E4c305530e199D7217f42808555B",
      chainId: chain.chainId,
      nonce: await client.getTransactionCount({
        address: eoa7702.address,
      }),
    }),
  });

  console.log("Transaction Hash:", transactionHash);
}

sendTransactionTest();
