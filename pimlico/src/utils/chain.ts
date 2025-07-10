import { baseSepolia, arbitrumSepolia, sepolia, optimismSepolia, polygonAmoy, bscTestnet } from "viem/chains";

async function getChain(
  chain: "SEPOLIA" | "BASE_SEPOLIA" | "ARBITRUM_SEPOLIA" | "OPTIMISM_SEPOLIA" | "POLYGON_AMOY" | "BNB_TESTNET",
) {
  let chainConfig;
  let chainId;
  let chainOrg;
  if (chain === "BASE_SEPOLIA") {
    chainConfig = baseSepolia;
    chainId = 84532;
    chainOrg = "https://base-sepolia.drpc.org";
  } else if (chain === "ARBITRUM_SEPOLIA") {
    chainConfig = arbitrumSepolia;
    chainId = 421614;
    chainOrg = "https://arbitrum-sepolia.drpc.org";
  } else if (chain === "SEPOLIA") {
    chainConfig = sepolia;
    chainId = 11155111;
    chainOrg = "https://sepolia.drpc.org";
  } else if (chain === "OPTIMISM_SEPOLIA") {
    chainConfig = optimismSepolia;
    chainId = 11155420;
    chainOrg = "https://optimism-sepolia.drpc.org";
  } else if (chain === "POLYGON_AMOY") {
    chainConfig = polygonAmoy;
    chainId = 80002;
    chainOrg = "https://polygon-amoy.drpc.org";
  } else if (chain === "BNB_TESTNET") {
    chainConfig = bscTestnet;
    chainId = 97;
    chainOrg = "https://bsc-testnet.drpc.org";
  } else {
    throw new Error("Invalid chain specified");
  }

  return {
    chainConfig,
    chainId,
    chainOrg,
  };
}

export default getChain;
