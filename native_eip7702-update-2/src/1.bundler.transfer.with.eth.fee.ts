// userop.eth_with_erc20_fee.ts
import "dotenv/config";
import { http, parseEther, parseUnits, encodeFunctionData } from "viem";
import { createPaymasterClient } from "viem/account-abstraction";
import type { SignAuthorizationReturnType } from "viem";

import { commonClient, publicClient } from "./client";   // free-bundler & L1 RPC
import { getSmartAccount } from "./account";             // toSimple7702SmartAccount(wrapper)
import { parseArgs } from "./utils";

// Minimal ERC20 ABI
const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol",   stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{type:"address",name:"to"},{type:"uint256",name:"amount"}], outputs: [{ type: "bool" }] },
] as const;

function bump(x?: bigint, pct: bigint = 150n) {
  return x ? (x * pct) / 100n : undefined; // +50% safety
}

async function getEntryPointAddress(): Promise<`0x${string}`> {
  const eps = (await commonClient.request({ method: "eth_supportedEntryPoints", params: [] })) as `0x${string}`[];
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
    } catch (ee) {
      console.warn("eth_getUserOperationByHash failed:", ee);
    }
    try {
      const eps = await commonClient.request({
        method: "eth_supportedEntryPoints",
        params: [],
      });
      console.log("supported EntryPoints =", eps);
    } catch (ee) {
      console.warn("eth_supportedEntryPoints failed:", ee);
    }
    throw e;
  }
}

async function main() {
  const args = parseArgs();

  // === Inputs ===
  const recipient = (args.to || process.env.RECEIPENT_ADDRESS || process.env.TO) as `0x${string}`;
  const ethAmountHuman = args["value-eth"] || process.env.ETH_AMOUNT || "0.000005";

  const feeToken     = (args["fee-token"]     || process.env.FEE_TOKEN_ADDRESS) as `0x${string}`;
  const feeReceiver  = (args["fee-receiver"]  || process.env.FEE_RECEIVER) as `0x${string}`;
  const feeAmountRaw = args["fee-amount"]     || process.env.FEE_AMOUNT;           // 최소단위 정수(wei or token decimals)
  const feeAmountHuman = args["fee-amount-human"] || process.env.FEE_AMOUNT_HUMAN; // 사람이 읽는 수(예: "1.2")
  const feeTokenDecimalsEnv = process.env.FEE_TOKEN_DECIMALS ? Number(process.env.FEE_TOKEN_DECIMALS) : undefined;

  const paymasterUrl      = args["paymaster-url"] || process.env.PAYMASTER_URL;
  const paymasterContextRaw = args["paymaster-context"] || process.env.PAYMASTER_CONTEXT || "";

  if (!recipient)  throw new Error("Missing recipient: --to or RECEIPENT_ADDRESS/TO is required");
  if (!feeToken)   throw new Error("Missing ERC20 fee token: --fee-token or FEE_TOKEN_ADDRESS");
  if (!feeReceiver)throw new Error("Missing fee receiver: --fee-receiver or FEE_RECEIVER");

  // === Smart Account (7702) ===
  const sa = await getSmartAccount();
  console.log("smartAccount.address =", sa.address);

  // If account not yet delegated to the implementation, sign authorization (7702 type-4)
  const code = await publicClient.getCode({ address: sa.address });
  const { address: implementation } = sa.authorization;
  const expectedPrefix = (`0xef0100${implementation.toLowerCase().slice(2)}`) as `0x${string}`;

  let authorization: SignAuthorizationReturnType | undefined;
  if (code !== expectedPrefix) {
    console.log("→ Not delegated; signing authorization for 7702…");
    authorization = await commonClient.signAuthorization(sa.authorization);
  }

  // === Resolve ERC20 fee decimals & amount ===
  let feeTokenDecimals = feeTokenDecimalsEnv;
  if (feeTokenDecimals === undefined) {
    try {
      feeTokenDecimals = Number(await publicClient.readContract({
        address: feeToken,
        abi: erc20Abi,
        functionName: "decimals",
      }));
    } catch {
      feeTokenDecimals = 6; // fallback
    }
  }

  let feeAmount: bigint;
  if (feeAmountRaw) {
    feeAmount = BigInt(feeAmountRaw);
  } else {
    const human = feeAmountHuman ?? "1";
    feeAmount = parseUnits(human, feeTokenDecimals);
  }

  // Optional: log fee token symbol & balance
  try {
    const [sym, bal] = await Promise.all([
      publicClient.readContract({ address: feeToken, abi: erc20Abi, functionName: "symbol" }).catch(() => "FEE"),
      publicClient.readContract({ address: feeToken, abi: erc20Abi, functionName: "balanceOf", args: [sa.address] }).catch(() => 0n),
    ]);
    console.log(`FeeToken: ${sym} (dec=${feeTokenDecimals}) balance=${bal.toString()}`);
    if (bal < feeAmount) {
      console.warn(`⚠️ Insufficient fee token balance. Need=${feeAmount.toString()}, Have=${bal.toString()}`);
    }
  } catch {/* ignore */}

  // === Build calls ===
  // 1) ERC20 fee transfer (from SA -> feeReceiver)
  const feeCall = {
    to: feeToken,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [feeReceiver, feeAmount],
    }),
  };

  // 2) ETH transfer (from SA -> recipient)
  const ethValue = parseEther(ethAmountHuman);
  const ethCall = {
    to: recipient,
    value: ethValue,
    data: "0x",
  };

  // Batch: fee first, then ETH
  const calls = [feeCall, ethCall];

  // === EntryPoint ===
  const entryPoint = await getEntryPointAddress();
  console.log("Using EntryPoint:", entryPoint);

  // === Fees (from public RPC, not bundler) ===
  const feeData = await publicClient.estimateFeesPerGas();
  const base = feeData.baseFeePerGas ?? 2_000_000_000n;  // 2 gwei floor
  const pri  = feeData.maxPriorityFeePerGas ?? 2_000_000_000n;
  const maxPriorityFeePerGas = bump(pri)!;
  const maxFeePerGas = bump(feeData.maxFeePerGas ?? (base + pri))!;

  console.log(
    "fees(gwei) =",
    "maxFeePerGas:", Number(maxFeePerGas) / 1e9,
    "maxPriorityFeePerGas:", Number(maxPriorityFeePerGas) / 1e9
  );

  // === Gas estimation (bare) on bundler ===
  const gasBare = await commonClient.estimateUserOperationGas({
    account: sa,
    authorization,
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
    "call:", gasBare.callGasLimit?.toString(),
    "verify:", gasBare.verificationGasLimit?.toString(),
    "preverify:", gasBare.preVerificationGas?.toString()
  );

  // === Optional Paymaster (sponsorship) ===
  let paymaster: ReturnType<typeof createPaymasterClient> | undefined;
  let paymasterContext: any | undefined;
  if (paymasterUrl) {
    paymaster = createPaymasterClient({ transport: http(paymasterUrl) });
    if (paymasterContextRaw) {
      try {
        paymasterContext = JSON.parse(paymasterContextRaw);
      } catch {
        throw new Error("PAYMASTER_CONTEXT must be valid JSON.");
      }
    } else if (/pimlico/i.test(paymasterUrl)) {
      console.warn('⚠️ Pimlico: PAYMASTER_CONTEXT with {"sponsorshipPolicyId":"sp_..."} is typically required.');
    }
  }

  // === Send UserOperation ===
  const userOpHash = await commonClient.sendUserOperation({
    account: sa,
    authorization,
    calls,

    entryPoint,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,

    ...(paymaster ? { paymaster, paymasterContext } : {}),
  });

  console.log("userOpHash =", userOpHash);

  const receipt = await waitOrDebug(userOpHash);
  console.log("UserOp receipt =", receipt);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
