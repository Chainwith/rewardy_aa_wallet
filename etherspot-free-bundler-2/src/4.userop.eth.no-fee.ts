// case4.sponsor.eth.no-fee.ts
// 4337 + Paymaster 스폰서 + ETH 전송(수수료 차감 없음)
import 'dotenv/config';
import { http, parseEther, createWalletClient } from 'viem';
import { createPaymasterClient } from 'viem/account-abstraction';
import { commonClient, publicClient, chain } from './client';
import { getSmartAccount, getOwnerFromEnv } from './account';

type Hex = `0x${string}`;
const ENTRYPOINT_V08: Hex = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';

const envOrThrow = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`Missing ${k}`); return v; };
const bump = (x?: bigint, pct: bigint = 150n) => (x ? (x * pct) / 100n : undefined);

async function getEntryPointAddress(): Promise<`0x${string}`> {
  const eps = (await commonClient.request({ method: 'eth_supportedEntryPoints', params: [] })) as `0x${string}`[];
  if (!eps?.length) throw new Error('No supported EntryPoints from bundler');
  return eps[0];
}
async function waitOrDebug(hash: `0x${string}`) {
  try {
    return await commonClient.waitForUserOperationReceipt({ hash, timeout: 180_000, pollingInterval: 3_000 });
  } catch (e) {
    try { console.log('eth_getUserOperationByHash =', await commonClient.request({ method: 'eth_getUserOperationByHash', params: [hash] })); } catch {}
    try { console.log('supported EntryPoints =', await commonClient.request({ method: 'eth_supportedEntryPoints', params: [] })); } catch {}
    throw e;
  }
}

async function main() {
  const TO = envOrThrow('TO') as `0x${string}`;
  const VALUE_ETH = process.env.VALUE_ETH ?? '0.00001';
  const paymasterUrl = envOrThrow('PAYMASTER_URL');

  const paymasterClient = createPaymasterClient({ transport: http(paymasterUrl) });
  const smartAccount = await getSmartAccount();
  console.log('smartAccount.address =', smartAccount.address);

  // 7702 위임 체크
  const senderCode = await publicClient.getCode({ address: smartAccount.address });
  const { address: delegateAddress } = smartAccount.authorization;
  const expectedPrefix = (`0xef0100${delegateAddress.toLowerCase().slice(2)}`) as Hex;

  let authorization: any | undefined;
  if (senderCode !== expectedPrefix) {
    const owner = getOwnerFromEnv();
    const chainId = await publicClient.getChainId();
    const txNonce = await publicClient.getTransactionCount({ address: owner.address, blockTag: 'latest' });
    const walletClient = createWalletClient({ account: owner, chain, transport: http(process.env.RPC_URL!) });
    authorization = await walletClient.signAuthorization({ address: delegateAddress as Hex, chainId, nonce: txNonce });
    console.log('Signed authorization for 7702 delegation.');
  }

  const entryPoint = await getEntryPointAddress();
  if (entryPoint.toLowerCase() !== ENTRYPOINT_V08.toLowerCase()) {
    console.warn('⚠️ Bundler EP != canonical v0.8');
  }

  const feeData = await publicClient.estimateFeesPerGas();
  const base = feeData.baseFeePerGas ?? 2_000_000_000n;
  const pri  = feeData.maxPriorityFeePerGas ?? 2_000_000_000n;
  const maxPriorityFeePerGas = bump(pri)!;
  const maxFeePerGas         = bump(feeData.maxFeePerGas ?? base + pri)!;

  const ethCall = { to: TO, value: parseEther(VALUE_ETH), data: '0x' as Hex };
  const calls = [ethCall];

  const gasBare = await commonClient.estimateUserOperationGas({
    account: smartAccount,
    authorization,
    calls,
    entryPoint,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  const callGasLimit         = bump(gasBare.callGasLimit, 130n);
  const verificationGasLimit = bump(gasBare.verificationGasLimit, 130n);
  const preVerificationGas   = bump(gasBare.preVerificationGas, 130n);

  const userOpHash = await commonClient.sendUserOperation({
    account: smartAccount,
    authorization,
    calls,
    entryPoint,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    paymaster: paymasterClient,
  });
  console.log('userOpHash =', userOpHash);

  const receipt = await waitOrDebug(userOpHash);
  console.log('UserOp receipt =', receipt);
}

main().catch((e) => { console.error(e); process.exit(1); });
