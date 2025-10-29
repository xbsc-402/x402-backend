import { verifyTypedData, type Address, type Hex } from 'viem';

/**
 * EIP-712 Domain for Mint Request signatures
 */
export const MINT_REQUEST_DOMAIN = {
  name: 'TokenLaunchpad',
  version: '1',
  // chainId and verifyingContract will be set dynamically
} as const;

/**
 * EIP-712 Types for Mint Request
 */
export const MINT_REQUEST_TYPES = {
  MintRequest: [
    { name: 'tokenAddress', type: 'address' },
    { name: 'recipients', type: 'address[]' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/**
 * Mint Request Message structure
 */
export interface MintRequestMessage {
  tokenAddress: Address;
  recipients: Address[];
  nonce: Hex;
  deadline: bigint;
}

/**
 * Verify a mint request signature
 * @param message The mint request message
 * @param signature The signature (0x...)
 * @param expectedSigner The expected signer address (token owner)
 * @param chainId The chain ID
 * @returns true if signature is valid
 */
export async function verifyMintSignature(
  message: MintRequestMessage,
  signature: Hex,
  expectedSigner: Address,
  chainId: number
): Promise<boolean> {
  try {
    const valid = await verifyTypedData({
      address: expectedSigner,
      domain: {
        ...MINT_REQUEST_DOMAIN,
        chainId,
        verifyingContract: message.tokenAddress,
      },
      types: MINT_REQUEST_TYPES,
      primaryType: 'MintRequest',
      message,
      signature,
    });

    return valid;
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Check if a deadline has expired
 * @param deadline Unix timestamp in seconds
 * @returns true if expired
 */
export function isDeadlineExpired(deadline: bigint): boolean {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return now > deadline;
}
