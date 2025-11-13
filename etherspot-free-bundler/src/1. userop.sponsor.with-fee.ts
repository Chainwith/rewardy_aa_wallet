// userop.sponsor.with-fee.ts
// 7702 + Etherspot Free-Bundler(4337 v0.8) + ERC20 fee + ETH transfer

import "dotenv/config";
import {
  http,
  parseEther,
  parseUnits,
  encodeFunctionData,
  createWalletClient, // 🔧 추가
} from "viem";
import { createPaymasterClient } from "viem/account-abstraction";
import { commonClient, publicClient, chain } from "./client";
import { getSmartAccount, getOwnerFromEnv } from "./account"; // 🔧 owner 가져오기

type Hex = `0x${string}`;

const ENTRYPOINT_V08: Hex = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";

const erc20Abi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address", name: "account" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

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

async function getFeesL2Safe() {
  try {
    const f = await publicClient.estimateFeesPerGas();
    if (f.maxFeePerGas && f.maxPriorityFeePerGas) {
      return {
        maxFeePerGas: bump(f.maxFeePerGas)!,
        maxPriorityFeePerGas: bump(f.maxPriorityFeePerGas)!,
      };
    }
  } catch {}

  // Fallback (L2: priority가 비어있을 수 있음)
  const gp = await publicClient.getGasPrice();
  // 보수적으로 동일 값 세팅 (Arbitrum/OP 계열에서 일반적)
  return {
    maxFeePerGas: bump(gp)!, // 1.5x 등
    maxPriorityFeePerGas: bump(gp)!, // 동일 값으로 채움
  };
}

async function main() {
  // ===== ENV =====
  const to = envOrThrow("TO") as `0x${string}`;
  const valueEth = process.env.VALUE_ETH ?? "0.000005";
  const bundlerPaymasterUrl = envOrThrow("PAYMASTER_URL");
  const paymasterContextRaw = process.env.PAYMASTER_CONTEXT ?? "";
  const feeToken = envOrThrow("FEE_TOKEN_ADDRESS") as `0x${string}`;
  const feeReceiver = envOrThrow("FEE_RECEIVER") as `0x${string}`;

  // fee amount
  let feeAmount: bigint;
  if (process.env.FEE_AMOUNT) {
    feeAmount = BigInt(process.env.FEE_AMOUNT);
  } else {
    const human = process.env.FEE_AMOUNT_HUMAN ?? "1";
    const dec = Number(process.env.FEE_TOKEN_DECIMALS ?? "6");
    feeAmount = parseUnits(human, dec);
  }

  // Paymaster
  const paymasterClient = createPaymasterClient({
    transport: http(bundlerPaymasterUrl),
  });

  // Smart Account
  const smartAccount = await getSmartAccount();
  console.log("smartAccount.address =", smartAccount.address);

  // ===== Authorization (7702) 서명은 L1 RPC로 처리 🔧 =====
  const senderCode = await publicClient.getCode({
    address: smartAccount.address,
  });
  const { address: delegateAddress } = smartAccount.authorization;
  const expectedPrefix = `0xef0100${delegateAddress
    .toLowerCase()
    .slice(2)}` as Hex;

  let authorization: any | undefined;

  if (senderCode !== expectedPrefix) {
    // 아직 위임 안됨 → owner 로컬 서명 + nonce는 publicClient에서 조회
    const owner = getOwnerFromEnv(); // PrivateKeyAccount
    const chainId = await publicClient.getChainId();
    console.log("chainId", chainId);
    const bundlerChainIdHex = await commonClient.request({
      method: "eth_chainId",
      params: [],
    }); // "0x14a34" 기대
    const bundlerChainId = Number(bundlerChainIdHex);
    console.log("chabundlerChainIdinId", bundlerChainId);

    const txNonce = await publicClient.getTransactionCount({
      address: owner.address,
      blockTag: "latest", // 스폰서 경로이므로 +1 불필요
    });

    // walletClient는 L1 RPC로 생성 (bundler 아님) 🔧
    const walletClient = createWalletClient({
      account: owner,
      chain,
      transport: http(process.env.RPC_URL!), // 반드시 풀노드 RPC
    });

    authorization = await walletClient.signAuthorization({
      address: delegateAddress as Hex,
      chainId,
      nonce: txNonce,
    });
    console.log(
      `Signed authorization: {address:${delegateAddress}, chainId:${chainId}, nonce:${txNonce}}`
    );
  } else {
    console.log("Already delegated to implementation. Skipping authorization.");
  }

  // ===== Network / EP / Gas =====
  const [chainId, block] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber(),
  ]);
  console.log("[rpc]", { chainId, block: block.toString(), chain: chain.name });

  const entryPoint = await getEntryPointAddress();
  console.log("Bundler EntryPoint:", entryPoint);
  if (entryPoint.toLowerCase() !== ENTRYPOINT_V08.toLowerCase()) {
    console.warn(
      `⚠️ Bundler EP != v0.8 canonical (${ENTRYPOINT_V08}). Got: ${entryPoint}`
    );
  }

  const feeData = await publicClient.estimateFeesPerGas();
  const { maxFeePerGas, maxPriorityFeePerGas } = await getFeesL2Safe();

  // const base = feeData.baseFeePerGas ?? 2_000_000_000n;
  // const pri = feeData.maxPriorityFeePerGas ?? 2_000_000_000n;
  // const maxPriorityFeePerGas = bump(pri)!;
  // const maxFeePerGas = bump(feeData.maxFeePerGas ?? base + pri)!;

  console.log(
    "fees(gwei) =",
    "maxFeePerGas:",
    Number(maxFeePerGas) / 1e9,
    "maxPriorityFeePerGas:",
    Number(maxPriorityFeePerGas) / 1e9
  );

  // ===== Calls: [ ERC20 fee transfer, ETH transfer ] =====
  const valueWei = parseEther(valueEth);

  const [balEth, feeTokenBal] = await Promise.all([
    publicClient.getBalance({ address: smartAccount.address }),
    publicClient
      .readContract({
        abi: erc20Abi,
        address: feeToken,
        functionName: "balanceOf",
        args: [smartAccount.address],
      })
      .catch(() => 0n),
  ]);

  if (balEth < valueWei) {
    console.warn(
      `⚠️ Low ETH balance on smartAccount: need ${valueEth}, have ${balEth} wei`
    );
  }
  if (feeTokenBal < feeAmount) {
    throw new Error(
      `Insufficient fee token balance: have=${feeTokenBal} need=${feeAmount}`
    );
  }

  const feeCall = {
    to: feeToken,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [feeReceiver, feeAmount],
    }) as Hex,
  };
  const ethCall = { to, value: valueWei, data: "0x" as Hex };

  const calls = [feeCall, ethCall]; // 수수료 먼저

  // 1) Gas estimate (no paymaster)
  const gasBare = await commonClient.estimateUserOperationGas({
    account: smartAccount,
    authorization, // 있을 때만 포함
    calls,
    entryPoint,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  const callGasLimit = bump(gasBare.callGasLimit, 130n);
  const verificationGasLimit = bump(gasBare.verificationGasLimit, 130n);
  const preVerificationGas = bump(gasBare.preVerificationGas, 130n);

  console.log(
    "estimated gas (bare) =",
    "call:",
    gasBare.callGasLimit?.toString(),
    "verify:",
    gasBare.verificationGasLimit?.toString(),
    "preverify:",
    gasBare.preVerificationGas?.toString()
  );

  // 2) Send with Paymaster
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

    entryPoint,
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
