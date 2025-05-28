import { toMultichainNexusAccount } from "@biconomy/abstractjs";
import * as dotenv from "dotenv";
import { Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, optimism, optimismSepolia } from "viem/chains";
dotenv.config();

async function delegated() {
  // 1. Private Key to EOA Account
  const eoaAccount = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);

  // 2. create Smart Account
  const smartAccount = await toMultichainNexusAccount({
    signer: eoaAccount, // 서명자
    chains: [base, optimism, baseSepolia, optimismSepolia],
    transports: [http(), http(), http(), http()],
  });

  // isDelegated: 스마트 계정이 위임된 상태인지 확인
  // unDelegate : 스마트 계정의 위임을 해제

  const delegationStatus = await smartAccount.isDelegated();

  if (delegationStatus) {
    // delegate 상태
    console.log("Account is delegated on at least one chain");
  } else {
    // undelegate 상태
    console.log("Account is not delegated on any chain");
  }
}

delegated();
