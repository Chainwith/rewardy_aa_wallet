import * as dotenv from "dotenv";
dotenv.config();
import { createThirdwebClient } from "thirdweb";
import { getWalletBalance, privateKeyToAccount, smartWallet, inAppWallet } from "thirdweb/wallets";
import { base, baseSepolia, celo } from "thirdweb/chains";

async function eip7702Test() {
  const client = createThirdwebClient({
    secretKey: process.env.THIRDWEB_SECRET_KEY as string,
  });

  console.log(client);

  const personalAccount = privateKeyToAccount({
    client,
    privateKey: process.env.PRIVATE_KEY as `0x${string}`,
  });

  console.log("Personal Account:", personalAccount);

  const wallet = inAppWallet({
    executionMode: {
      mode: "EIP7702", // EIP 7702 모드
      sponsorGas: true, // Paymaster 가스 후원 사용
    },
  });

  const smartAccount = await wallet.connect({
    client,
    strategy: "wallet",
    chain: baseSepolia,
  });

  console.log("Smart Account:", smartAccount);

  // balance 확인
  const balance = await getWalletBalance({
    client,
    chain: baseSepolia,
    address: smartAccount.address,
  });

  console.log("Smart Account Balance:", balance);
}

eip7702Test();
