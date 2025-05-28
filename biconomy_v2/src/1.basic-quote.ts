import { createMeeClient, mcUSDC, toMultichainNexusAccount } from "@biconomy/abstractjs";
import * as dotenv from "dotenv";
import { Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, optimism, optimismSepolia } from "viem/chains";
dotenv.config();

async function quoteExample() {
  // 1. Private Key to EOA Account
  const eoaAccount = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);

  // 2. create Smart Account
  const smartAccount = await toMultichainNexusAccount({
    signer: eoaAccount, // 서명자
    chains: [base, optimism, baseSepolia, optimismSepolia],
    transports: [http(), http(), http(), http()],
  });

  // 3. create Mee Client: MEE 노드에 대한 연결을 생성하는 초기화 (biconomy network)
  const meeClient = await createMeeClient({
    account: smartAccount,
    apiKey: process.env.MEE_API_KEY,
  });

  // 사전 계산
  const quote = await meeClient.getQuote({
    instructions: [
      {
        calls: [
          {
            to: eoaAccount.address,
            value: 100000000000000n, // 0.0001 ETH
            gasLimit: 21000n,
          },
        ],
        chainId: optimismSepolia.id,
      },
    ],
    feeToken: {
      address: "0x0000000000000000000000000000000000000000", // Native Token
      // address : mcUSDC.addressOn(base.id) // USDC Token
      chainId: optimismSepolia.id,
    },
  });
  console.log("Quote:", quote);

  // 서명
  const signQuote = await meeClient.signQuote({ quote });
  console.log("Signed Quote:", signQuote);

  // 트랜잭션 실행 : 실제 블록체인에 실행
  const { hash } = await meeClient.executeQuote({ quote });
  console.log("Transaction Hash:", hash);

  // Wait for Transaction Receipt : 마이닝 될때까지 기다리는 로직
  const receipt = await meeClient.waitForSupertransactionReceipt({ hash });
  console.log("Transaction Status:", receipt.transactionStatus);
  console.log("Explorer links:", receipt.explorerLinks);
}

quoteExample();
