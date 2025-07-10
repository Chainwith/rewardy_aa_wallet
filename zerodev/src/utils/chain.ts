import { baseSepolia, arbitrumSepolia, sepolia, optimismSepolia, polygonAmoy } from "viem/chains";

async function getChain(chain: "SEPOLIA" | "BASE_SEPOLIA" | "ARBITRUM_SEPOLIA" | "OPTIMISM_SEPOLIA" | "POLYGON_AMOY") {
  if (chain === "BASE_SEPOLIA") {
    return baseSepolia;
  } else if (chain === "ARBITRUM_SEPOLIA") {
    return arbitrumSepolia;
  } else if (chain === "SEPOLIA") {
    return sepolia;
  } else if (chain === "OPTIMISM_SEPOLIA") {
    return optimismSepolia;
  } else if (chain === "POLYGON_AMOY") {
    return polygonAmoy;
  } else {
    throw new Error("Invalid chain specified");
  }
}

async function getChainId(
  chain: "SEPOLIA" | "BASE_SEPOLIA" | "ARBITRUM_SEPOLIA" | "OPTIMISM_SEPOLIA" | "POLYGON_AMOY",
) {
  if (chain === "BASE_SEPOLIA") {
    return 84532;
  } else if (chain === "ARBITRUM_SEPOLIA") {
    return 421614;
  } else if (chain === "SEPOLIA") {
    return 11155111;
  } else if (chain === "OPTIMISM_SEPOLIA") {
    return 11155420;
  } else if (chain === "POLYGON_AMOY") {
    return 80002;
  } else {
    throw new Error("Invalid chain specified");
  }
}

export { getChainId, getChain };
