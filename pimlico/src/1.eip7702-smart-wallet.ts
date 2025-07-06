import * as dotenv from "dotenv";
dotenv.config();

import { createPublicClient, Hex, http } from "viem";
import { createSmartAccountClient } from "permissionless";
import { toSimple7702SmartAccount } from "viem/account-abstraction";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";

async function createSmartAccount() {
  const privateKey = process.env.PRIVATE_KEY as `0x${string}`;

  const eoa7702 = privateKeyToAccount(privateKey);

  console.log("EOA Address:", eoa7702.address);

  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(`https://base-sepolia.drpc.org`),
  });

  console.log("Client :", client);

  const simple7702Account = await toSimple7702SmartAccount({
    client,
    owner: eoa7702,
  });

  console.log("Smart Account Address:", simple7702Account.address);

  const pimlicoClient = createPimlicoClient({
    chain: baseSepolia,
    transport: http(`https://api.pimlico.io/v2/84532/rpc?apikey=${process.env.PIMLICO_API_KEY}`),
  });

  const smartAccountClient = createSmartAccountClient({
    client,
    chain: baseSepolia,
    account: simple7702Account,
    paymaster: pimlicoClient,
    bundlerTransport: http(`https://api.pimlico.io/v2/84532/rpc?apikey=${process.env.PIMLICO_API_KEY}`),
  });

  console.log("Smart Account Client Address:", smartAccountClient.account.address);
}

createSmartAccount();
