import * as dotenv from "dotenv";
dotenv.config();
import {
  createThirdwebClient,
  estimateGas,
  prepareTransaction,
  sendTransaction,
  toWei,
  waitForReceipt,
} from "thirdweb";
import { getWalletBalance, privateKeyToAccount, smartWallet } from "thirdweb/wallets";
import { base, baseSepolia, celo } from "thirdweb/chains";
import { parseEther } from "viem";

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

  // balance 확인
  const balance = await getWalletBalance({
    client,
    chain: baseSepolia,
    address: smartAccount.address,
  });

  console.log("Smart Account Balance:", balance);

  // prepare Transaction

  const RECIPIENT = "0x636f2433e640EcbC043d1AA2F6F42ff240441cd9";

  const transaction = prepareTransaction({
    to: RECIPIENT,
    value: toWei("0.001"),
    chain: baseSepolia,
    client,
  });

  console.log("Prepared Transaction:", transaction);

  // gas estimate
  const gasEstimate = await estimateGas({ transaction });
  console.log("estmated gas used", gasEstimate);

  const transactionResult = await sendTransaction({
    transaction,
    account: smartAccount,
  });

  console.log("Transaction Result:", transactionResult);

  const receipt = await waitForReceipt(transactionResult);

  console.log("Transaction Receipt:", receipt);
}

createSmartAccountClient();
