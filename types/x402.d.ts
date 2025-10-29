declare module "x402/schemes" {
  import type { PaymentPayload } from "x402/types";

  export const exact: {
    evm: {
      decodePayment: (paymentHeader: string) => PaymentPayload;
    };
  };
}

declare module "x402/types" {
  export type Authorization = {
    from: string;
    to: string;
    value: string;
    nonce: string;
    validAfter?: string;
    validBefore?: string;
    data?: `0x${string}`;
  };

  export type PaymentPayload = {
    payload: {
      chainId: number;
      authorization: Authorization;
      contract: string;
      signature: string;
    };
    metadata?: Record<string, unknown>;
    resource?: string;
  };

  export type SettleResponse = {
    transaction: string;
    status: "submitted" | "confirmed" | "failed";
    errorMessage?: string;
  };

  export function settleResponseHeader(response: SettleResponse): string;
}
