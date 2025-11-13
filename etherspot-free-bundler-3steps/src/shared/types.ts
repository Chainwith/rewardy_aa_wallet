// src/shared/types.ts
import type { Hex } from "./helpers";

export type Call = { to: Hex; value: string; data: Hex };

export type BuiltTR = {
  caseId: 1 | 2 | 3 | 4;
  chainId: number;
  accountAddress: Hex;
  delegateAddress: Hex;
  entryPointHint?: Hex;          // bundler EP at build time (optional)
  calls: Call[];                 // value는 문자열(wei)로 저장
  paymasterUrl?: string;
  paymasterContext?: any;
  notes?: string;
  needAuthorization: boolean;    // build 시점에 위임 필요 여부
};

export type SignedTR = BuiltTR & {
  authorization?: {
    address: Hex;
    chainId: number;
    nonce: number;
    r: Hex;
    s: Hex;
    yParity: Hex;
  };
};
