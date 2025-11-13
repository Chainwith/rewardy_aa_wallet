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
;
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
async function createAuthorization(nonce: number) {
  const auth = await firstSigner.authorize({
    address: targetAddress,
    nonce: nonce,
    // chainId: 11155111, // Sepolia chain ID
  });

  console.log("Authorization created with nonce:", auth.nonce);
  return auth;
}
// STEP 3: Send a Non-Sponsored EIP-7702 Transaction
// STEP 4: Send a Sponsored EIP-7702 Transaction
// Function to create signature for sponsored calls, it's needed in the implementation contract
async function createSignatureForCalls(calls: any[], contractNonce: number) {
  // Encode the calls for signature
  let encodedCalls = "0x";
  for (const call of calls) {
    const [to, value, data] = call;
    encodedCalls += ethers
      .solidityPacked(["address", "uint256", "bytes"], [to, value, data])
      .slice(2);
  }

  // Create the digest that needs to be signed
  const digest = ethers.keccak256(
    ethers.solidityPacked(["uint256", "bytes"], [contractNonce, encodedCalls])
  );

  // Sign the digest with the EOA's private key
  return await firstSigner.signMessage(ethers.getBytes(digest));
}

async function sendSponsoredTransaction() {
  console.log("\n=== TRANSACTION 2: SPONSORED (CONTRACT FUNCTION CALLS) ===");

  // Prepare ERC20 transfer call data
  const erc20ABI = [
    "function transfer(address to, uint256 amount) external returns (bool)",
  ];
  const erc20Interface = new ethers.Interface(erc20ABI);

  const pyusd = '0x0c36c6Ff413AB3311A71C671613ad77AfDd919DF';

  const calls = [ 
    // [
    //   '0xadA8A2c713B371D589Ec53f27e5Dd9F2BA56Ee54',
    //   0n,
    //   erc20Interface.encodeFunctionData("transfer1", [
    //     recipientAddress,
    //     ethers.parseUnits("10", 6), // 10 USDC
    //   ]),
    // ],
    [Wallet.createRandom().address, ethers.parseEther("0.000001"), "0x"],
    [Wallet.createRandom().address, ethers.parseEther("0.000002"), "0x"],
    [Wallet.createRandom().address, ethers.parseEther("0.000003"), "0x"],
  ];

  // Create contract instance for sponsored transaction
  const delegatedContract = new ethers.Contract(
    firstSigner.address,
    contractABI,
    sponsorSigner,
  );

  // Get contract nonce and create signature
  const contractNonce = await delegatedContract['nonce']({
    type: 4
  });

  const auth = await createAuthorization(contractNonce);
  const signature = await createSignatureForCalls(calls, contractNonce);

//   await checkUSDCBalance(firstSigner.address, "First Signer (Sender)");

  // Execute sponsored transaction
  const tx = await delegatedContract[
    "executeWithPYUSD((address,uint256,bytes)[],bytes)"
  ](calls, signature, {
    type: 4,                   // Reusing existing delegation.
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
    await  sendSponsoredTransaction();
}

run();
