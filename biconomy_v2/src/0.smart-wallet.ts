import { createMeeClient, mcUSDC, toMultichainNexusAccount } from "@biconomy/abstractjs";
import * as dotenv from "dotenv";
import { Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, optimism, optimismSepolia } from "viem/chains";
dotenv.config();

async function createSmartWallet() {
  // 1. Private Key to EOA Account
  const eoaAccount = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
  console.log("EOA address:", eoaAccount.address);

  // 2. create Smart Account
  const smartAccount = await toMultichainNexusAccount({
    signer: eoaAccount, // 서명자
    chains: [base, optimism, baseSepolia, optimismSepolia], // 계정이 상호작용할 체인들
    transports: [http(), http(), http(), http()], // 체인에 대한 전송 수단 (체인 index에 맞춰야함)
  });

  // 3. create Mee Client: MEE 노드에 대한 연결을 생성하는 초기화 (biconomy network)
  const meeClient = await createMeeClient({
    account: smartAccount,
    apiKey: process.env.MEE_API_KEY,
  });

  // addressOn(chain.id) : Multichain Account여서 동일한 주소가 나와야함
  console.log("Smart account address on Optimism:", smartAccount.addressOn(optimism.id));
  console.log("Smart account address on Base:", smartAccount.addressOn(base.id));
  console.log("Smart account address on Optimism Sepolia:", smartAccount.addressOn(optimismSepolia.id));
  console.log("Smart account address on Base Seploia:", smartAccount.addressOn(baseSepolia.id));

  // deploymentOn(chain.id) : 해당 체인에 배포된 스마트 계정의 배포 정보 확인 : 첫번째 트랜잭션이 일어나기전까지는 False 상태
  const optimismDeployment = smartAccount.deploymentOn(optimism.id);
  const baseDeployment = smartAccount.deploymentOn(base.id);
  const optimismSepoliaDeployment = smartAccount.deploymentOn(optimismSepolia.id);
  const baseSepoliaDeployment = smartAccount.deploymentOn(baseSepolia.id);
  console.log(`Deployment Optimism status: ${(await optimismDeployment?.isDeployed()) ? "Deployed" : "Not deployed"}`);
  console.log(`Deployment Base status: ${(await baseDeployment?.isDeployed()) ? "Deployed" : "Not deployed"}`);
  console.log(
    `Deployment Optimism Seploia status: ${
      (await optimismSepoliaDeployment?.isDeployed()) ? "Deployed" : "Not deployed"
    }`,
  );
  console.log(
    `Deployment Base Sepolia status: ${(await baseSepoliaDeployment?.isDeployed()) ? "Deployed" : "Not deployed"}`,
  );
}

createSmartWallet();
