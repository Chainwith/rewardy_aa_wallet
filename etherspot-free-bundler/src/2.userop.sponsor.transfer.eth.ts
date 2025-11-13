// userop.sponsor.transfer.eth.ts
// 7702 + Etherspot Free-Bundler(4337 v0.8) + ETH transfer (no ERC20 fee)

import "dotenv/config";
import {
  http,
  parseEther,
  createWalletClient,
} from "viem";
import { createPaymasterClient } from "viem/account-abstraction";
import { commonClient, publicClient, chain } from "./client";
import { getSmartAccount, getOwnerFromEnv } from "./account";

type Hex = `0x${string}`;

const ENTRYPOINT_V08: Hex = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";

function envOrThrow(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env ${key}`);
  return v;
}
function bump(x?: bigint, pct: bigint = 150n) {
  return x ? (x * pct) / 100n : undefined;
}

async function getEntryPointAddress(): Promise<`0x${string}`> {
  const eps = (await commonClient.request({
    method: "eth_supportedEntryPoints",
    params: [],
  })) as `0x${string}`[];
  if (!eps?.length) throw new Error("No supported EntryPoints from bundler");
  return eps[0];
}

async function waitOrDebug(hash: `0x${string}`) {
  try {
    return await commonClient.waitForUserOperationReceipt({
      hash,
      timeout: 180_000,
      pollingInterval: 3_000,
    });
  } catch (e) {
    console.warn("Timed out. Debugging…");
    try {
      const uo = await commonClient.request({
        method: "eth_getUserOperationByHash",
        params: [hash],
      });
      console.log("eth_getUserOperationByHash =", uo);
    } catch {}
    try {
      const eps = await commonClient.request({
        method: "eth_supportedEntryPoints",
        params: [],
      });
      console.log("supported EntryPoints =", eps);
    } catch {}
    throw e;
  }
}

async function main() {
  // ===== ENV =====
  const to = envOrThrow("TO") as `0x${string}`;
  const valueEth = process.env.VALUE_ETH ?? "0.00001"; // 보낼 ETH 양(사람 단위)
  const bundlerPaymasterUrl = envOrThrow("PAYMASTER_URL");
  const paymasterContextRaw = process.env.PAYMASTER_CONTEXT ?? "";

  // ===== Paymaster (sponsor) =====
  const paymasterClient = createPaymasterClient({
    transport: http(bundlerPaymasterUrl),
  });

  // ===== Smart Account (7702) =====
  const smartAccount = await getSmartAccount();
  console.log("smartAccount.address =", smartAccount.address);

  // ----- 7702 Authorization (위임 안되어 있으면 서명) -----
  const senderCode = await publicClient.getCode({ address: smartAccount.address });
  const { address: delegateAddress } = smartAccount.authorization;
  const expectedPrefix = (`0xef0100${delegateAddress.toLowerCase().slice(2)}`) as Hex;

  let authorization: any | undefined;
  if (senderCode !== expectedPrefix) {
    const owner = getOwnerFromEnv(); // PrivateKeyAccount
    const chainId = await publicClient.getChainId();
    const txNonce = await publicClient.getTransactionCount({
      address: owner.address,
      blockTag: "latest",
    });

    const walletClient = createWalletClient({
      account: owner,
      chain,
      transport: http(process.env.RPC_URL!), // L1 RPC
    });

    authorization = await walletClient.signAuthorization({
      address: delegateAddress as Hex,
      chainId,
      nonce: txNonce,
    });
    console.log(`Signed authorization: {address:${delegateAddress}, chainId:${chainId}, nonce:${txNonce}}`);
  } else {
    console.log("Already delegated to implementation. Skipping authorization.");
  }

  // ===== Network / EP / Gas =====
  const [chainId, block] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber(),
  ]);
  console.log("[rpc]", { chainId, block: block.toString(), chain: chain.name });

  const bundlerEP = await getEntryPointAddress();
  console.log("Bundler EntryPoint:", bundlerEP);
  if (bundlerEP.toLowerCase() !== ENTRYPOINT_V08.toLowerCase()) {
    console.warn(`⚠️ Bundler EP != v0.8 canonical (${ENTRYPOINT_V08}). Got: ${bundlerEP}`);
  }

  const feeData = await publicClient.estimateFeesPerGas();
  const base = feeData.baseFeePerGas ?? 2_000_000_000n;
  const pri = feeData.maxPriorityFeePerGas ?? 2_000_000_000n;
  const maxPriorityFeePerGas = bump(pri)!;
  const maxFeePerGas = bump(feeData.maxFeePerGas ?? base + pri)!;

  console.log(
    "fees(gwei) =",
    "maxFeePerGas:", Number(maxFeePerGas) / 1e9,
    "maxPriorityFeePerGas:", Number(maxPriorityFeePerGas) / 1e9
  );

  // ===== Call: [ ETH transfer ] =====
  const valueWei = parseEther(valueEth);

  const balEth = await publicClient.getBalance({ address: smartAccount.address });
  if (balEth < valueWei) {
    console.warn(`⚠️ Low ETH balance on smartAccount: need ${valueEth}, have ${balEth} wei`);
  }

  const ethCall = { to, value: valueWei, data: "0x" as Hex };
  const calls = [ethCall];

  // ===== 1) 가스 추정 (paymaster 없이) =====
  const gasBare = await commonClient.estimateUserOperationGas({
    account: smartAccount,
    authorization, // 있을 때만 포함
    calls,
    entryPoint: bundlerEP,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  const callGasLimit = bump(gasBare.callGasLimit, 130n);
  const verificationGasLimit = bump(gasBare.verificationGasLimit, 130n);
  const preVerificationGas = bump(gasBare.preVerificationGas, 130n);

  console.log(
    "estimated gas (bare) =",
    "call:", gasBare.callGasLimit?.toString(),
    "verify:", gasBare.verificationGasLimit?.toString(),
    "preverify:", gasBare.preVerificationGas?.toString()
  );

  // ===== 2) Paymaster 스폰서로 전송 =====
  let paymasterContext: any | undefined;
  if (paymasterContextRaw) {
    try {
      paymasterContext = JSON.parse(paymasterContextRaw);
    } catch {
      throw new Error("PAYMASTER_CONTEXT must be valid JSON");
    }
  }

  const userOpHash = await commonClient.sendUserOperation({
    account: smartAccount,
    authorization, // 있을 때만
    calls,

    entryPoint: bundlerEP,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,

    paymaster: paymasterClient,
    paymasterContext,
  });

  console.log("userOpHash =", userOpHash);

  const receipt = await waitOrDebug(userOpHash);
  console.log("UserOp receipt =", receipt);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
