import { arbitrumSepolia, baseSepolia, sepolia, optimismSepolia, polygonAmoy } from "@account-kit/infra";

async function getChain(
  chain: "SEPOLIA" | "BASE_SEPOLIA" | "ARBITRUM_SEPOLIA" | "BSC_TESTNET" | "OPTIMISM_SEPOLIA" | "POLYGON_AMOY",
) {
  if (chain === "BASE_SEPOLIA") {
    return baseSepolia;
  } else if (chain === "ARBITRUM_SEPOLIA") {
    return arbitrumSepolia;
  } else if (chain === "BSC_TESTNET") {
    return {
      id: 97,
      name: "BNB Chain Testnet",
      network: "BNB Chain Testnet",
      nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
      rpcUrls: {
        default: {
          http: ["https://bnb-testnet.g.alchemy.com/v2/SM_rtCu0vbatB7qdpLNBh"],
        },
        public: {
          http: ["https://bnb-testnet.g.alchemy.com/v2/SM_rtCu0vbatB7qdpLNBh"],
        },
        alchemy: {
          http: ["https://bnb-testnet.g.alchemy.com/v2/SM_rtCu0vbatB7qdpLNBh"],
        },
      },
    };
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

export default getChain;
