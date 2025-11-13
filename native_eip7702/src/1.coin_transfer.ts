import "dotenv/config";
import { ethers, Wallet } from "ethers";
import { contractABI } from "./contract";

// Global variables for reusability
let provider: ethers.JsonRpcProvider,
  firstSigner: ethers.Wallet,
  sponsorSigner: ethers.Wallet,
  targetAddress: string,
  recipientAddress: string;

async function initializeSigners() {
  // Check environment variables
  if (
    !process.env.FIRST_PRIVATE_KEY ||
    !process.env.SPONSOR_PRIVATE_KEY ||
    !process.env.DELEGATION_CONTRACT_ADDRESS ||
    !process.env.RECEIPENT_ADDRESS ||
    !process.env.RPC_URL
  ) {
    console.error("Please set your environmental variables in .env file.");
    process.exit(1);
  }

  console.log("process.env.RPC_URL", process.env.RPC_URL);

  provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

  firstSigner = new ethers.Wallet(process.env.FIRST_PRIVATE_KEY, provider);
  sponsorSigner = new ethers.Wallet(process.env.SPONSOR_PRIVATE_KEY, provider);

  targetAddress = process.env.DELEGATION_CONTRACT_ADDRESS;
  recipientAddress = process.env.RECEIPENT_ADDRESS;

  console.log("First Signer Address:", firstSigner.address);
  console.log("Sponsor Signer Address:", sponsorSigner.address);

  // Check balances
  const firstBalance = await provider.getBalance(firstSigner.address);
  const sponsorBalance = await provider.getBalance(sponsorSigner.address);
  console.log("First Signer Balance:", ethers.formatEther(firstBalance), "ETH");
  console.log(
    "Sponsor Signer Balance:",
    ethers.formatEther(sponsorBalance),
    "ETH"
  );
}


// STEP 2: Create Authorization for the EOA\
async function createAuthorization(nonce: bigint | number) {
  const auth = await firstSigner.authorize({
    address: targetAddress,
    nonce,               // bigint/number 모두 허용됨
    // chainId: 11155111,
  });
  console.log("Authorization created with nonce:", auth.nonce);
  return auth;
}

// STEP 3: Send a Non-Sponsored EIP-7702 Transaction
// STEP 4: Send a Sponsored EIP-7702 Transaction
// Function to create signature for sponsored calls, it's needed in the implementation contract
async function createSignatureForCalls(calls: any[], contractNonce: bigint | number) {
  let encodedCalls = "0x";
  for (const call of calls) {
    const [to, value, data] = call;
    encodedCalls += ethers
      .solidityPacked(["address", "uint256", "bytes"], [to, value, data])
      .slice(2);
  }
  const digest = ethers.keccak256(
    ethers.solidityPacked(["uint256", "bytes"], [contractNonce, encodedCalls])
  );
  return await firstSigner.signMessage(ethers.getBytes(digest)); // Solidity에서 toEthSignedMessageHash와 매칭
}

async function sendSponsoredTransaction() {
  console.log("\n=== TRANSACTION 2: SPONSORED (CONTRACT FUNCTION CALLS) ===");

  // Prepare ERC20 transfer call data
  const erc20ABI = [
    "function transfer1(address to, uint256 amount) external returns (bool)",
  ];
  const erc20Interface = new ethers.Interface(erc20ABI);

  const calls = [
    [Wallet.createRandom().address, ethers.parseEther("0.000001"), "0x"],
    [Wallet.createRandom().address, ethers.parseEther("0.000002"), "0x"],
    [Wallet.createRandom().address, ethers.parseEther("0.000003"), "0x"],
  ];

  console.log("1===");

  // Create contract instance for sponsored transaction
  const delegatedContract = new ethers.Contract(
    firstSigner.address,
    contractABI,
    sponsorSigner
  );

  console.log("2===");

  // Get contract nonce and create signature
  // const contractNonce = await delegatedContract["nonce"]({
  //   type: 4,
  // });

  // Ethers v6: getStorage(address, position)
  const raw = await provider
    .getStorage(firstSigner.address, 0n)
    .catch(() => "0x0");
  // getStorage가 없는 구현체면 getStorageAt로 fallback
  const rawSlot0 =
    raw ?? (await (provider as any).getStorageAt(firstSigner.address, 0));
  const contractNonce = BigInt(rawSlot0 || "0x0");
  console.log("3===", contractNonce.toString());

  const auth = await createAuthorization(contractNonce);
  const signature = await createSignatureForCalls(calls, contractNonce);

  //   await checkUSDCBalance(firstSigner.address, "First Signer (Sender)");

  // Execute sponsored transaction
  const tx = await delegatedContract[
    "execute((address,uint256,bytes)[],bytes)"
  ](calls, signature, {
    type: 4, // Reusing existing delegation.
    authorizationList: [auth], // New auth or EIP-7702 type are not needed.
  });

  console.log("Sponsored transaction sent:", tx.hash);

  const receipt = await tx.wait();
  console.log("Receipt for sponsored transaction:", receipt);

  // Check USDC balances after transaction
  console.log("\n--- USDC BALANCES AFTER SPONSORED TX ---");
  //   await checkUSDCBalance(firstSigner.address, "First Signer (Sender)");

  return receipt;
}
// STEP 5: Check USDC Balance
// STEP 6: Revoke Delegation
// STEP 7: Run the Full Workflow

const run = async () => {
  await initializeSigners();

  // await createAuthorization();
  // await checkDelegationStatus();
  await sendSponsoredTransaction();
};

run();
