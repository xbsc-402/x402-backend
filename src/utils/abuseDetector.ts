/**
 * Abuse Detection and Ban Manager
 * Detects and bans addresses/IPs that send excessive verified requests
 */

import { Redis } from 'ioredis';
import { RedisConnectionManager } from './redisConnectionPool.js';

export interface AbuseConfig {
  maxRequestsPerWindow: number;  // Maximum requests allowed in time window
  timeWindowMs: number;          // Time window in milliseconds
  banDurationMs: number;         // Ban duration in milliseconds
}

export class AbuseDetector {
  private redis: Redis | null = null;
  private redisUrl: string | undefined;
  private config: AbuseConfig;
  
  private readonly REQUEST_COUNT_PREFIX = 'abuse:count:';
  private readonly BAN_PREFIX = 'abuse:ban:';
  private readonly WHITELIST_PREFIX = 'abuse:whitelist:';

  constructor(redisUrl?: string, config?: Partial<AbuseConfig>) {
    this.redisUrl = redisUrl;
    this.config = {
      maxRequestsPerWindow: config?.maxRequestsPerWindow || 10,
      timeWindowMs: config?.timeWindowMs || 60000, // Default: 10 requests per minute
      banDurationMs: config?.banDurationMs || 3600000, // Default: 1 hour ban
    };

    console.log(`🛡️  AbuseDetector initialized with config:
      Max requests: ${this.config.maxRequestsPerWindow} per ${this.config.timeWindowMs / 1000}s
      Ban duration: ${this.config.banDurationMs / 1000}s`);
  }

  private async ensureConnection(): Promise<Redis | null> {
    if (!this.redis && this.redisUrl) {
      this.redis = await RedisConnectionManager.getConnection(this.redisUrl);
    }
    return this.redis;
  }

  /**
   * Check if identifier is whitelisted
   */
  private async isWhitelisted(key: string): Promise<boolean> {
    const redis = await this.ensureConnection();
    if (!redis) return false;
    
    const whitelistKey = this.WHITELIST_PREFIX + key;
    const exists = await redis.exists(whitelistKey);
    return exists === 1;
  }

  /**
   * Record a request and check if limit is exceeded
   * @returns true if request is allowed, false if banned or limit exceeded
   */
  async recordRequest(identifier: string): Promise<{ allowed: boolean; reason?: string }> {
    const redis = await this.ensureConnection();
    if (!redis) {
      console.warn('⚠️  AbuseDetector - Redis not available, allowing request');
      return { allowed: true };
    }

    const key = `${identifier}`.toLowerCase();

    try {
      // Check if whitelisted first (bypass all checks)
      if (await this.isWhitelisted(key)) {
        console.log(`✅ AbuseDetector - Request allowed: ${key} is whitelisted`);
        return { allowed: true };
      }

      // Check if already banned
      const isBanned = await this.isBanned(key);
      if (isBanned) {
        const ttl = await redis.ttl(this.BAN_PREFIX + key);
        console.log(`🚫 AbuseDetector - Request blocked: ${key} is banned (${ttl}s remaining)`);
        return {
          allowed: false,
          reason: `Banned for excessive requests. Try again in ${Math.ceil(ttl / 60)} minutes.`,
        };
      }

      // Increment request count
      const countKey = this.REQUEST_COUNT_PREFIX + key;
      const count = await redis.incr(countKey);

      // Set expiration on first request
      if (count === 1) {
        await redis.pexpire(countKey, this.config.timeWindowMs);
      }

      // Check if limit exceeded
      if (count > this.config.maxRequestsPerWindow) {
        console.log(`⚠️  AbuseDetector - Limit exceeded for ${key}: ${count} requests`);
        
        // Ban the identifier
        await this.banIdentifier(key);
        
        return {
          allowed: false,
          reason: `Rate limit exceeded. Maximum ${this.config.maxRequestsPerWindow} requests per ${this.config.timeWindowMs / 1000} seconds.`,
        };
      }

      console.log(`✅ AbuseDetector - Request allowed for ${key}: ${count}/${this.config.maxRequestsPerWindow}`);
      return { allowed: true };
    } catch (error: any) {
      console.error(`❌ AbuseDetector - Error recording request:`, error.message);
      // On error, allow the request (fail open)
      return { allowed: true };
    }
  }

  /**
   * Ban an identifier
   */
  private async banIdentifier(identifier: string): Promise<void> {
    const redis = await this.ensureConnection();
    if (!redis) return;

    const key = this.BAN_PREFIX + identifier;
    try {
      await redis.set(key, '1', 'PX', this.config.banDurationMs);
      console.log(`🚫 AbuseDetector - Banned ${identifier} for ${this.config.banDurationMs / 1000}s`);
    } catch (error: any) {
      console.error(`❌ AbuseDetector - Failed to ban ${identifier}:`, error.message);
    }
  }

  /**
   * Check if an identifier is banned
   */
  async isBanned(identifier: string): Promise<boolean> {
    const redis = await this.ensureConnection();
    if (!redis) return false;

    const key = this.BAN_PREFIX + identifier;
    try {
      const result = await redis.exists(key);
      return result === 1;
    } catch (error: any) {
      console.error(`❌ AbuseDetector - Error checking ban status:`, error.message);
      return false;
    }
  }

  /**
   * Manually ban an identifier
   */
  async manualBan(identifier: string, durationMs?: number): Promise<void> {
    const redis = await this.ensureConnection();
    if (!redis) return;

    const key = this.BAN_PREFIX + identifier;
    const duration = durationMs || this.config.banDurationMs;
    
    try {
      await redis.set(key, '1', 'PX', duration);
      console.log(`🚫 AbuseDetector - Manually banned ${identifier} for ${duration / 1000}s`);
    } catch (error: any) {
      console.error(`❌ AbuseDetector - Failed to manually ban ${identifier}:`, error.message);
    }
  }

  /**
   * Unban an identifier
   */
  async unban(identifier: string): Promise<void> {
    const redis = await this.ensureConnection();
    if (!redis) return;

    try {
      const countKey = this.REQUEST_COUNT_PREFIX + identifier;
      const banKey = this.BAN_PREFIX + identifier;
      
      await redis.del(countKey, banKey);
      console.log(`✅ AbuseDetector - Unbanned ${identifier}`);
    } catch (error: any) {
      console.error(`❌ AbuseDetector - Failed to unban ${identifier}:`, error.message);
    }
  }

  /**
   * Get current request count for an identifier
   */
  async getRequestCount(identifier: string): Promise<number> {
    const redis = await this.ensureConnection();
    if (!redis) return 0;

    const key = this.REQUEST_COUNT_PREFIX + identifier;
    try {
      const count = await redis.get(key);
      return count ? parseInt(count, 10) : 0;
    } catch (error: any) {
      console.error(`❌ AbuseDetector - Error getting request count:`, error.message);
      return 0;
    }
  }

  /**
   * Add identifier to whitelist (永久豁免限流)
   */
  async addToWhitelist(identifier: string): Promise<void> {
    const redis = await this.ensureConnection();
    if (!redis) {
      throw new Error('Redis not available');
    }

    const key = `${identifier}`.toLowerCase();
    const whitelistKey = this.WHITELIST_PREFIX + key;
    
    try {
      await redis.set(whitelistKey, '1');
      console.log(`✅ AbuseDetector - Added to whitelist: ${key}`);
    } catch (error: any) {
      console.error(`❌ AbuseDetector - Error adding to whitelist:`, error.message);
      throw error;
    }
  }

  /**
   * Remove identifier from whitelist
   */
  async removeFromWhitelist(identifier: string): Promise<void> {
    const redis = await this.ensureConnection();
    if (!redis) {
      throw new Error('Redis not available');
    }

    const key = `${identifier}`.toLowerCase();
    const whitelistKey = this.WHITELIST_PREFIX + key;
    
    try {
      await redis.del(whitelistKey);
      console.log(`✅ AbuseDetector - Removed from whitelist: ${key}`);
    } catch (error: any) {
      console.error(`❌ AbuseDetector - Error removing from whitelist:`, error.message);
      throw error;
    }
  }

  /**
   * Get abuse statistics
   */
  async getStats(identifier: string): Promise<{
    requestCount: number;
    isBanned: boolean;
    isWhitelisted: boolean;
    banTimeRemaining?: number;
  }> {
    const redis = await this.ensureConnection();
    if (!redis) {
      return { requestCount: 0, isBanned: false, isWhitelisted: false };
    }

    try {
      const key = `${identifier}`.toLowerCase();
      const [requestCount, isBanned, isWhitelisted, banTTL] = await Promise.all([
        this.getRequestCount(identifier),
        this.isBanned(identifier),
        this.isWhitelisted(key),
        redis.ttl(this.BAN_PREFIX + identifier),
      ]);

      return {
        requestCount,
        isBanned,
        isWhitelisted,
        banTimeRemaining: isBanned && banTTL > 0 ? banTTL : undefined,
      };
    } catch (error: any) {
      console.error(`❌ AbuseDetector - Error getting stats:`, error.message);
      return { requestCount: 0, isBanned: false, isWhitelisted: false };
    }
  }
}

/**
 * Create identifier from address and IP
 */
export function createIdentifier(address?: string, ip?: string): string {
  if (address && ip) {
    return `addr:${address.toLowerCase()}_ip:${ip}`;
  } else if (address) {
    return `addr:${address.toLowerCase()}`;
  } else if (ip) {
    return `ip:${ip}`;
  } else {
    return 'unknown';
  }
}

