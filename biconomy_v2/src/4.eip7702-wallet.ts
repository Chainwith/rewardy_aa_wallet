import * as dotenv from "dotenv";
dotenv.config();

import { toMultichainNexusAccount } from "@biconomy/abstractjs";
import { createWalletClient, Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createMeeClient } from "@biconomy/abstractjs";
import {
  arbitrumSepolia,
  base,
  baseSepolia,
  bscTestnet,
  optimism,
  optimismSepolia,
  polygonAmoy,
  sepolia,
} from "viem/chains";

async function delegated() {
  // 1. Private Key to EOA Account
  const eoaAccount = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);

  console.log("EOA address:", eoaAccount.address);

  const walletClient = createWalletClient({
    transport: http("https://sepolia.drpc.org"),
  });

  console.log("Wallet Client created", walletClient);

  // 2. create Smart Account
  const nexus120Singleton = "0x000000004F43C49e93C970E84001853a70923B03";

  const authorization = await walletClient.signAuthorization({
    account: eoaAccount,
    contractAddress: nexus120Singleton,
    chainId: 0,
    nonce: 0,
  });

  const orchestrator = await toMultichainNexusAccount({
    chains: [optimismSepolia, baseSepolia],
    transports: [
      http(),
      http(),
      // http("https://sepolia.drpc.org"),
      // http("https://sepolia-rollup.arbitrum.io/rpc"),
      // http("https://polygon-amoy.drpc.org"),
      // http("https://bsc-testnet.drpc.org"),
    ],
    signer: eoaAccount,

    accountAddress: eoaAccount.address,
  });

  console.log("Orchestrator Address:", orchestrator.addressOn(optimismSepolia.id));

  const meeClient = await createMeeClient({
    account: orchestrator,
    apiKey: process.env.MEE_API_KEY,
  });

  console.log("Mee Client created", meeClient);
}

delegated();
