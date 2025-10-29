import { type Address, type Hex } from 'viem';
import { randomBytes } from 'crypto';
import {
  verifyTransferWithAuthorization,
  isAuthorizationValid,
  splitSignature,
  type TransferWithAuthorizationMessage,
} from './eip3009.js';
import { USDC_ABI } from './contracts.js';

/**
 * Payment request storage
 * In production, use Redis with TTL
 */
interface PaymentRequest {
  id: string;
  amount: bigint;
  payee: Address;
  token: Address;
  nonce: Hex;
  validBefore: bigint;
  createdAt: number;
  fulfilled: boolean;
  txHash?: Hex;
  metadata?: Record<string, any>; // Store mint request details
}

// In-memory storage (replace with Redis in production)
const paymentRequests = new Map<string, PaymentRequest>();
const fulfilledPayments = new Map<Hex, string>(); // txHash -> payment ID

/**
 * Create a new payment request
 */
export function createPaymentRequest(
  amount: bigint,
  payee: Address,
  token: Address,
  validitySeconds: number = 600,
  metadata?: Record<string, any>
): PaymentRequest {
  const id = randomBytes(16).toString('hex');
  const nonce = ('0x' + randomBytes(32).toString('hex')) as Hex;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + validitySeconds);

  const request: PaymentRequest = {
    id,
    amount,
    payee,
    token,
    nonce,
    validBefore,
    createdAt: Date.now(),
    fulfilled: false,
    metadata,
  };

  paymentRequests.set(id, request);

  return request;
}

/**
 * Get a payment request by ID
 */
export function getPaymentRequest(id: string): PaymentRequest | undefined {
  return paymentRequests.get(id);
}

/**
 * Check if a payment has been fulfilled by txHash
 */
export function isPaymentFulfilled(txHash: Hex): boolean {
  return fulfilledPayments.has(txHash);
}

/**
 * Get payment request by txHash
 */
export function getPaymentByTxHash(txHash: Hex): PaymentRequest | undefined {
  const paymentId = fulfilledPayments.get(txHash);
  if (!paymentId) return undefined;
  return paymentRequests.get(paymentId);
}

/**
 * Submit and process an authorization
 */
export async function submitAuthorization(
  authorization: TransferWithAuthorizationMessage,
  signature: Hex,
  walletClient: any,
  publicClient: any,
  chainId: number
): Promise<{ success: boolean; txHash?: Hex; error?: string }> {
  try {
    // 1. Find the payment request by nonce
    let paymentRequest: PaymentRequest | undefined;
    for (const [, request] of paymentRequests) {
      if (request.nonce === authorization.nonce && !request.fulfilled) {
        paymentRequest = request;
        break;
      }
    }

    if (!paymentRequest) {
      return { success: false, error: 'Payment request not found or already fulfilled' };
    }

    // 2. Verify the authorization matches the request
    if (
      authorization.to.toLowerCase() !== paymentRequest.payee.toLowerCase() ||
      authorization.value < paymentRequest.amount
    ) {
      return {
        success: false,
        error: 'Authorization does not match payment request',
      };
    }

    // 3. Check time window
    if (!isAuthorizationValid(authorization.validAfter, authorization.validBefore)) {
      return { success: false, error: 'Authorization time window invalid' };
    }

    // 4. Get token name for signature verification
    const tokenName = (await publicClient.readContract({
      address: paymentRequest.token,
      abi: USDC_ABI,
      functionName: 'name',
    })) as string;

    // 5. Verify signature
    const isValid = await verifyTransferWithAuthorization(
      authorization,
      signature,
      paymentRequest.token,
      tokenName,
      chainId
    );

    if (!isValid) {
      return { success: false, error: 'Invalid signature' };
    }

    // 6. Check authorization state (not used)
    const authState = (await publicClient.readContract({
      address: paymentRequest.token,
      abi: USDC_ABI,
      functionName: 'authorizationState',
      args: [authorization.from, authorization.nonce],
    })) as bigint;

    if (authState !== 0n) {
      return { success: false, error: 'Authorization nonce already used' };
    }

    // 7. Submit to blockchain (Backend acts as Facilitator)
    const { v, r, s } = splitSignature(signature);

    const hash = await walletClient.writeContract({
      address: paymentRequest.token,
      abi: USDC_ABI,
      functionName: 'transferWithAuthorization',
      args: [
        authorization.from,
        authorization.to,
        authorization.value,
        authorization.validAfter,
        authorization.validBefore,
        authorization.nonce,
        v,
        r,
        s,
      ],
    });

    // 8. Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });

    if (receipt.status !== 'success') {
      return { success: false, error: 'Transaction failed' };
    }

    // 9. Mark as fulfilled
    paymentRequest.fulfilled = true;
    paymentRequest.txHash = hash;
    fulfilledPayments.set(hash, paymentRequest.id);

    console.log(`✅ Payment fulfilled: ${hash}`);
    console.log(`   From: ${authorization.from}`);
    console.log(`   To: ${authorization.to}`);
    console.log(`   Amount: ${authorization.value}`);

    return { success: true, txHash: hash };
  } catch (error: any) {
    console.error('Authorization submission error:', error);
    return { success: false, error: error.message || 'Failed to submit authorization' };
  }
}

/**
 * Clean up expired payment requests (call periodically)
 */
export function cleanupExpiredRequests(): void {
  const now = Date.now();
  for (const [id, request] of paymentRequests) {
    // Remove requests older than 1 hour
    if (now - request.createdAt > 3600000) {
      paymentRequests.delete(id);
      console.log(`Cleaned up expired payment request: ${id}`);
    }
  }
}

/**
 * Get all pending payment requests (for debugging)
 */
export function getPendingPayments(): PaymentRequest[] {
  return Array.from(paymentRequests.values()).filter((r) => !r.fulfilled);
}

/**
 * Get all fulfilled payment requests (for debugging)
 */
export function getFulfilledPayments(): PaymentRequest[] {
  return Array.from(paymentRequests.values()).filter((r) => r.fulfilled);
}
