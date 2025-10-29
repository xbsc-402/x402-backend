import { verifyTypedData, type Address, type Hex } from 'viem';

/**
 * EIP-3009: Transfer With Authorization
 * https://eips.ethereum.org/EIPS/eip-3009
 */

// ==================== Type Definitions ====================

/**
 * EIP-3009 TransferWithAuthorization message
 */
export interface TransferWithAuthorizationMessage {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

/**
 * EIP-3009 ReceiveWithAuthorization message
 */
export interface ReceiveWithAuthorizationMessage {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

/**
 * EIP-3009 CancelAuthorization message
 */
export interface CancelAuthorizationMessage {
  authorizer: Address;
  nonce: Hex;
}

// ==================== EIP-712 Domain and Types ====================

/**
 * Get EIP-712 domain for a token contract
 */
export function getEIP3009Domain(tokenAddress: Address, chainId: number) {
  return {
    name: 'USDC', // This should match the token's name
    version: '2',
    chainId,
    verifyingContract: tokenAddress,
  };
}

/**
 * EIP-712 Types for TransferWithAuthorization
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/**
 * EIP-712 Types for ReceiveWithAuthorization
 */
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/**
 * EIP-712 Types for CancelAuthorization
 */
export const CANCEL_AUTHORIZATION_TYPES = {
  CancelAuthorization: [
    { name: 'authorizer', type: 'address' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// ==================== Signature Verification ====================

/**
 * Verify a TransferWithAuthorization signature
 * @param message The transfer authorization message
 * @param signature The signature (0x...)
 * @param tokenAddress The token contract address
 * @param chainId The chain ID
 * @returns true if signature is valid
 */
export async function verifyTransferWithAuthorization(
  message: TransferWithAuthorizationMessage,
  signature: Hex,
  tokenAddress: Address,
  tokenName: string,
  chainId: number
): Promise<boolean> {
  try {
    const valid = await verifyTypedData({
      address: message.from,
      domain: {
        name: tokenName,
        version: '2',
        chainId,
        verifyingContract: tokenAddress,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message,
      signature,
    });

    return valid;
  } catch (error) {
    console.error('TransferWithAuthorization signature verification error:', error);
    return false;
  }
}

/**
 * Verify a ReceiveWithAuthorization signature
 */
export async function verifyReceiveWithAuthorization(
  message: ReceiveWithAuthorizationMessage,
  signature: Hex,
  tokenAddress: Address,
  tokenName: string,
  chainId: number
): Promise<boolean> {
  try {
    const valid = await verifyTypedData({
      address: message.from,
      domain: {
        name: tokenName,
        version: '2',
        chainId,
        verifyingContract: tokenAddress,
      },
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: 'ReceiveWithAuthorization',
      message,
      signature,
    });

    return valid;
  } catch (error) {
    console.error('ReceiveWithAuthorization signature verification error:', error);
    return false;
  }
}

// ==================== Validation Helpers ====================

/**
 * Check if authorization is within valid time window
 */
export function isAuthorizationValid(validAfter: bigint, validBefore: bigint): boolean {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return now >= validAfter && now <= validBefore;
}

/**
 * Extract v, r, s from signature
 */
export function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  if (signature.length !== 132) {
    throw new Error('Invalid signature length');
  }

  const r = ('0x' + signature.slice(2, 66)) as Hex;
  const s = ('0x' + signature.slice(66, 130)) as Hex;
  const v = parseInt(signature.slice(130, 132), 16);

  return { v, r, s };
}
