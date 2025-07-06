import * as dotenv from "dotenv";
dotenv.config();
import { createThirdwebClient } from "thirdweb";
import { getWalletBalance, privateKeyToAccount, smartWallet } from "thirdweb/wallets";
import { base, baseSepolia, celo } from "thirdweb/chains";

async function createSmartAccountClient() {
  const client = createThirdwebClient({
    secretKey: process.env.THIRDWEB_SECRET_KEY as string,
  });

  console.log(client);

  const personalAccount = privateKeyToAccount({
    client,
    privateKey: process.env.PRIVATE_KEY as `0x${string}`,
  });

  console.log("Personal Account:", personalAccount);

  const wallet = smartWallet({
    chain: baseSepolia,
    sponsorGas: true,
  });

  const smartAccount = await wallet.connect({
    client,
    personalAccount,
  });

  console.log("Smart Account:", smartAccount);
}

createSmartAccountClient();
