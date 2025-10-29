/**
 * Token Capacity Manager
 * Manages token mint capacity to prevent exceeding maxMintCount limit
 */

import { Address, createPublicClient, http } from 'viem';
import { Redis } from 'ioredis';
import { RedisConnectionManager } from './redisConnectionPool.js';
import { getRandomBscRpc } from 'x402/src/types/shared/evm/wallet.js';

// X402 Token ABI
const X402_TOKEN_ABI = [
  {
    inputs: [],
    name: 'maxMintCount',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'mintCount',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'deploymentDeadline',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * TokenDeadlineCache
 * Permanent cache for deployment deadline (contract configuration, never changes)
 */
export class TokenDeadlineCache {
  private cache = new Map<string, bigint>(); // Permanent cache
  private publicClient: any;

  constructor(chain: any) {
    this.publicClient = createPublicClient({
      chain,
      transport: http(getRandomBscRpc()),
    });
  }

  /**
   * Get the deployment deadline for a token (permanent cache)
   */
  async getDeploymentDeadline(tokenAddress: Address): Promise<bigint> {
    const cacheKey = tokenAddress.toLowerCase();
    const cached = this.cache.get(cacheKey);

    if (cached !== undefined) {
      return cached; // Permanent cache - once fetched, never query again
    }

    console.log(`🔍 Fetching deploymentDeadline for token ${tokenAddress} from chain...`);
    const deadline = await this.publicClient.readContract({
      address: tokenAddress,
      abi: X402_TOKEN_ABI,
      functionName: 'deploymentDeadline',
    }) as bigint;

    console.log(`   ✅ Deployment deadline: ${deadline} (${new Date(Number(deadline) * 1000).toISOString()})`);
    this.cache.set(cacheKey, deadline); // Store permanently
    return deadline;
  }

  /**
   * Check if a token has expired (current time > deploymentDeadline)
   */
  async isTokenExpired(tokenAddress: Address): Promise<boolean> {
    const deadline = await this.getDeploymentDeadline(tokenAddress);
    const now = BigInt(Math.floor(Date.now() / 1000));
    return now > deadline;
  }

  /**
   * Clear cache for a specific token (for testing only)
   */
  clearCache(tokenAddress?: Address) {
    if (tokenAddress) {
      this.cache.delete(tokenAddress.toLowerCase());
    } else {
      this.cache.clear();
    }
  }
}

/**
 * TokenMaxMint cache
 * Permanent cache for maximum mint count (contract configuration, never changes)
 */
export class TokenMaxMintCache {
  private cache = new Map<string, number>();
  private publicClient: any;

  constructor(chain: any) {
    this.publicClient = createPublicClient({
      chain,
      transport: http(getRandomBscRpc()),
    });
  }

  /**
   * Get the maximum mint count for a token (permanent cache)
   */
  async getMaxMintCount(tokenAddress: Address): Promise<number> {
    const cacheKey = tokenAddress.toLowerCase();
    const cached = this.cache.get(cacheKey);

    // Permanent cache - once fetched, never query again
    if (cached !== undefined) {
      return cached;
    }

    // Fetch from chain (only first time)
    console.log(`🔄 TokenMaxMintCache - First time fetching maxMintCount for ${tokenAddress}`);
    try {
      const maxCount = await this.publicClient.readContract({
        address: tokenAddress,
        abi: X402_TOKEN_ABI,
        functionName: 'maxMintCount',
      });

      const value = Number(maxCount);
      
      // Permanent cache
      this.cache.set(cacheKey, value);

      console.log(`✅ TokenMaxMintCache - Permanently cached maxMintCount for ${tokenAddress}: ${value}`);
      return value;
    } catch (error: any) {
      console.error(`❌ TokenMaxMintCache - Failed to fetch maxMintCount for ${tokenAddress}:`, error.message);
      throw error;
    }
  }

  /**
   * Clear cache (for testing or manual refresh)
   */
  clearCache(tokenAddress?: Address) {
    if (tokenAddress) {
      this.cache.delete(tokenAddress.toLowerCase());
      console.log(`🗑️ Cleared maxMintCount cache for ${tokenAddress}`);
    } else {
      this.cache.clear();
      console.log(`🗑️ Cleared all maxMintCount cache`);
    }
  }
}

/**
 * Pending Mint tracker
 * Real-time tracking of mint count waiting for execution in mempool
 */
export class PendingMintTracker {
  private redis: Redis | null = null;
  private redisUrl: string | undefined;
  private readonly keyPrefix = 'pending_mint:';

  constructor(redisUrl?: string) {
    this.redisUrl = redisUrl;
  }

  private async ensureConnection(): Promise<Redis | null> {
    if (!this.redis && this.redisUrl) {
      this.redis = await RedisConnectionManager.getConnection(this.redisUrl);
    }
    return this.redis;
  }

  /**
   * Increment pending count (when task is added to queue)
   */
  async incrementPending(tokenAddress: Address, count: number): Promise<number> {
    const redis = await this.ensureConnection();
    if (!redis) {
      console.warn('⚠️ PendingMintTracker - Redis not available, returning 0');
      return 0;
    }

    const key = this.keyPrefix + tokenAddress.toLowerCase();
    try {
      const newCount = await redis.incrby(key, count);
      console.log(`📈 PendingMintTracker - Incremented ${tokenAddress} by ${count}, new total: ${newCount}`);
      
      // Set expiration time to prevent data accumulation (1 hour)
      await redis.expire(key, 3600);
      
      return newCount;
    } catch (error: any) {
      console.error(`❌ PendingMintTracker - Failed to increment pending for ${tokenAddress}:`, error.message);
      return 0;
    }
  }

  /**
   * Decrement pending count (when mint execution is completed)
   */
  async decrementPending(tokenAddress: Address, count: number): Promise<number> {
    const redis = await this.ensureConnection();
    if (!redis) {
      console.warn('⚠️ PendingMintTracker - Redis not available, returning 0');
      return 0;
    }

    const key = this.keyPrefix + tokenAddress.toLowerCase();
    try {
      const newCount = await redis.decrby(key, count);
      
      // If count becomes 0 or negative, delete key
      if (newCount <= 0) {
        await redis.del(key);
        console.log(`🔻 PendingMintTracker - Decremented ${tokenAddress} by ${count}, removed key (was ${newCount})`);
        return 0;
      }
      
      console.log(`🔻 PendingMintTracker - Decremented ${tokenAddress} by ${count}, new total: ${newCount}`);
      return newCount;
    } catch (error: any) {
      console.error(`❌ PendingMintTracker - Failed to decrement pending for ${tokenAddress}:`, error.message);
      return 0;
    }
  }

  /**
   * Get current pending count
   */
  async getPendingCount(tokenAddress: Address): Promise<number> {
    const redis = await this.ensureConnection();
    if (!redis) {
      console.warn('⚠️ PendingMintTracker - Redis not available, returning 0');
      return 0;
    }

    const key = this.keyPrefix + tokenAddress.toLowerCase();
    try {
      const count = await redis.get(key);
      const value = count ? parseInt(count, 10) : 0;
      return value;
    } catch (error: any) {
      console.error(`❌ PendingMintTracker - Failed to get pending count for ${tokenAddress}:`, error.message);
      return 0;
    }
  }

  /**
   * Clear pending count for a specific token
   */
  async clearPending(tokenAddress: Address): Promise<void> {
    const redis = await this.ensureConnection();
    if (!redis) return;

    const key = this.keyPrefix + tokenAddress.toLowerCase();
    try {
      await redis.del(key);
      console.log(`🗑️ PendingMintTracker - Cleared pending for ${tokenAddress}`);
    } catch (error: any) {
      console.error(`❌ PendingMintTracker - Failed to clear pending for ${tokenAddress}:`, error.message);
    }
  }
}

/**
 * Token capacity information
 */
export interface TokenCapacityInfo {
  maxMintCount: number;      // Maximum mint count
  currentMintCount: number;  // Current minted count
  pendingCount: number;      // Pending count
  availableSlots: number;    // Available capacity
}

/**
 * Token capacity manager
 * Integrates maxMintCount cache and pending tracking
 */
export class TokenCapacityManager {
  private tokenCache: TokenMaxMintCache;
  private pendingTracker: PendingMintTracker;
  private publicClient: any;
  
  // MintCount short-term cache (6 seconds)
  private mintCountCache = new Map<string, { value: number; fetchedAt: number }>();
  private readonly mintCountTTL = 6000; // 6 seconds

  constructor(chain: any, redisUrl?: string) {
    this.tokenCache = new TokenMaxMintCache(chain);
    this.pendingTracker = new PendingMintTracker(redisUrl);
    this.publicClient = createPublicClient({
      chain,
      transport: http(getRandomBscRpc()),
    });
  }

  /**
   * Check if token has sufficient capacity
   * @returns Capacity information, throws error if capacity is insufficient
   */
  async checkCapacity(tokenAddress: Address, requestedCount: number): Promise<TokenCapacityInfo> {
    console.log(`🔍 TokenCapacityManager - Checking capacity for ${tokenAddress}, requested: ${requestedCount}`);

    // Get all required data in parallel
    const [currentMintCount, maxMintCount, pendingCount] = await Promise.all([
      this.getCurrentMintCount(tokenAddress),
      this.tokenCache.getMaxMintCount(tokenAddress),
      this.pendingTracker.getPendingCount(tokenAddress),
    ]);

    const totalExpected = currentMintCount + pendingCount + requestedCount;
    const availableSlots = maxMintCount - currentMintCount - pendingCount;

    const capacityInfo: TokenCapacityInfo = {
      maxMintCount,
      currentMintCount,
      pendingCount,
      availableSlots,
    };

    console.log(`📊 TokenCapacityManager - Capacity check results:
      Max: ${maxMintCount}
      Current: ${currentMintCount}
      Pending: ${pendingCount}
      Requested: ${requestedCount}
      Available: ${availableSlots}
      Total if approved: ${totalExpected}`);

    if (totalExpected > maxMintCount) {
      const error = new Error('Insufficient mint capacity');
      (error as any).code = 'CAPACITY_EXCEEDED';
      (error as any).capacityInfo = capacityInfo;
      throw error;
    }

    return capacityInfo;
  }

  /**
   * Reserve capacity (called before settle)
   */
  async reserveCapacity(tokenAddress: Address, count: number): Promise<void> {
    console.log(`🔒 TokenCapacityManager - Reserving ${count} slots for ${tokenAddress}`);
    await this.pendingTracker.incrementPending(tokenAddress, count);
  }

  /**
   * Release capacity (called when mint completes or fails)
   */
  async releaseCapacity(tokenAddress: Address, count: number): Promise<void> {
    console.log(`🔓 TokenCapacityManager - Releasing ${count} slots for ${tokenAddress}`);
    await this.pendingTracker.decrementPending(tokenAddress, count);
  }

  /**
   * Get current on-chain mint count (with 6-second cache)
   */
  private async getCurrentMintCount(tokenAddress: Address): Promise<number> {
    const cacheKey = tokenAddress.toLowerCase();
    const cached = this.mintCountCache.get(cacheKey);
    const now = Date.now();

    // Check 6-second cache
    if (cached && now - cached.fetchedAt < this.mintCountTTL) {
      return cached.value;
    }

    // Fetch from chain
    try {
      const mintCount = await this.publicClient.readContract({
        address: tokenAddress,
        abi: X402_TOKEN_ABI,
        functionName: 'mintCount',
      });
      
      const value = Number(mintCount);
      
      // Cache for 6 seconds
      this.mintCountCache.set(cacheKey, {
        value,
        fetchedAt: now,
      });
      
      console.log(`🔄 TokenCapacityManager - Fetched mintCount for ${tokenAddress}: ${value} (cached for 6s)`);
      return value;
    } catch (error: any) {
      console.error(`❌ TokenCapacityManager - Failed to get current mint count for ${tokenAddress}:`, error.message);
      
      // If there's old cache, return it even if expired
      if (cached) {
        console.warn(`⚠️ TokenCapacityManager - Returning stale mintCount cache for ${tokenAddress}: ${cached.value}`);
        return cached.value;
      }
      
      throw error;
    }
  }

  /**
   * Get complete capacity status (for debugging and monitoring)
   */
  async getCapacityStatus(tokenAddress: Address): Promise<TokenCapacityInfo> {
    const [currentMintCount, maxMintCount, pendingCount] = await Promise.all([
      this.getCurrentMintCount(tokenAddress),
      this.tokenCache.getMaxMintCount(tokenAddress),
      this.pendingTracker.getPendingCount(tokenAddress),
    ]);

    return {
      maxMintCount,
      currentMintCount,
      pendingCount,
      availableSlots: maxMintCount - currentMintCount - pendingCount,
    };
  }
}

// Export convenience function
export function createTokenCapacityManager(chain: any, redisUrl?: string): TokenCapacityManager {
  return new TokenCapacityManager(chain, redisUrl);
}

