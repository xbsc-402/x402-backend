/**
 * Redis Connection Pool Manager
 * Implements connection pool using ioredis Cluster mode or multiple independent connections
 */

import Redis from 'ioredis';
import { EventEmitter } from 'events';

interface PoolOptions {
  min?: number;           // Minimum connections
  max?: number;           // Maximum connections
  acquireTimeout?: number; // Connection acquisition timeout
  idleTimeout?: number;    // Idle connection timeout
  connectionTimeout?: number; // Connection timeout
  retryAttempts?: number;  // Retry attempts
}

class RedisConnectionPool extends EventEmitter {
  private redisUrl: string;
  private options: Required<PoolOptions>;
  private connections: Redis[] = [];
  private availableConnections: Redis[] = [];
  private waitingQueue: Array<(conn: Redis | null) => void> = [];
  private isShuttingDown = false;
  private connectionsInUse = new WeakSet<Redis>();
  private connectionLastUsed = new WeakMap<Redis, number>();
  private healthCheckInterval?: NodeJS.Timeout;
  private connectionIdMap = new WeakMap<Redis, number>();
  private nextConnectionId = 1;

  constructor(redisUrl: string, options: PoolOptions = {}) {
    super();
    this.redisUrl = redisUrl;
    this.options = {
      min: options.min || 2,
      max: options.max || 10,
      acquireTimeout: options.acquireTimeout || 3000,
      idleTimeout: options.idleTimeout || 300000, // Default 5 minutes
      connectionTimeout: options.connectionTimeout || 30000, // Default 30 seconds
      retryAttempts: options.retryAttempts || 5, // Default 5 times
    };

    // Initialize minimum connections
    this.initializePool();

    // Start health check
    this.startHealthCheck();
  }

  /**
   * Initialize connection pool
   */
  private async initializePool(): Promise<void> {
    console.log(`🏊 Initializing Redis connection pool (min: ${this.options.min}, max: ${this.options.max})`);

    const promises: Promise<void>[] = [];
    for (let i = 0; i < this.options.min; i++) {
      promises.push(this.createConnection());
    }

    await Promise.allSettled(promises);
    console.log(`✅ Redis pool initialized with ${this.connections.length} connections`);
  }

  /**
   * Create new Redis connection
   */
  private async createConnection(): Promise<void> {
    if (this.connections.length >= this.options.max) {
      throw new Error('Maximum connections reached');
    }

    // Assign ID to connection
    const connectionId = this.nextConnectionId++;
    
    const redis = new Redis(this.redisUrl, {
      connectTimeout: this.options.connectionTimeout, // Use configured connection timeout
      maxRetriesPerRequest: 1, // Maximum 1 retry per command
      enableAutoPipelining: true,
      enableOfflineQueue: false, // Don't cache offline commands, fail fast
      retryStrategy: (times) => {
        if (times > this.options.retryAttempts) {
          console.error(`❌ Connection #${connectionId} retry limit reached (${this.options.retryAttempts} attempts)`);
          return null; // Stop retrying
        }
        // Exponential backoff retry strategy
        const baseDelay = 2000; // Base delay 2 seconds
        const maxDelay = 30000; // Maximum delay 30 seconds
        const delay = Math.min(baseDelay * Math.pow(2, times - 1), maxDelay);
        console.log(`🔄 Connection #${connectionId} retrying in ${delay}ms (attempt ${times}/${this.options.retryAttempts})`);
        return delay;
      },
      lazyConnect: true,
      keepAlive: 30000, // Send keepalive packet every 30 seconds
      family: 4, // Use IPv4
      enableReadyCheck: true, // Ensure connection is truly available
      reconnectOnError: (err) => {
        // Don't reconnect for closed connection errors
        if (err.message.includes('Connection is closed')) {
          return false;
        }
        // Reconnect for READONLY errors
        if (err.message.includes('READONLY')) {
          return true;
        }
        // Let retry strategy handle other errors
        return false;
      },
      commandTimeout: 30000, // Command timeout 30 seconds (Alibaba Cloud Redis might be slow)
      noDelay: true, // Disable Nagle algorithm
      autoResubscribe: false, // Don't auto-resubscribe, avoid unnecessary operations
      autoResendUnfulfilledCommands: false, // Don't auto-resend unfulfilled commands, fail fast
    });
    
    // Set connection ID mapping
    this.connectionIdMap.set(redis, connectionId);

    // Set event listeners
    redis.on('connect', () => {
      console.log(`✅ Pool connection #${connectionId} connected`);
    });

    redis.on('error', (err) => {
      console.error(`❌ Pool connection #${connectionId} error:`, err.message);

      // All errors should remove connection from available pool
      // Including command timeout, as timeout indicates unhealthy connection
      this.handleConnectionError(redis);

      // For serious errors, close connection directly
      if (err.message.includes('ECONNRESET') ||
          err.message.includes('ECONNREFUSED') ||
          err.message.includes('Connection is closed')) {
        console.log(`🔄 Connection #${connectionId} fatal error, closing connection`);
        this.removeConnection(redis);
      }
    });

    redis.on('close', () => {
      console.log(`🔌 Pool connection #${connectionId} closed`);
      this.removeConnection(redis);

      // Don't auto-rebuild connections here to avoid infinite loops
      // Let health check mechanism maintain minimum connections
      if (!this.isShuttingDown && this.connections.length < this.options.min) {
        console.log(`📡 Connection count (${this.connections.length}) below minimum (${this.options.min}), will be handled by health check`);
      }
    });
    
    redis.on('ready', () => {
      console.log(`✨ Pool connection #${connectionId} ready`);
    });
    
    redis.on('end', () => {
      console.log(`🛑 Pool connection #${connectionId} ended`);
    });

    try {
      await redis.connect();
      this.connections.push(redis);
      this.availableConnections.push(redis);
      this.connectionLastUsed.set(redis, Date.now());
      console.log(`🎉 Pool connection #${connectionId} successfully created and added to pool`);
    } catch (error) {
      console.error(`❌ Failed to create connection #${connectionId}:`, error instanceof Error ? error.message : String(error));
      // Clean up failed connection
      this.connectionIdMap.delete(redis);
      redis.disconnect(false);
      throw error;
    }
  }

  /**
   * Acquire an available connection
   */
  async acquire(): Promise<Redis | null> {
    console.log(`🔵 acquire() called - available: ${this.availableConnections.length}, total: ${this.connections.length}, max: ${this.options.max}`);

    if (this.isShuttingDown) {
      console.log(`⚠️ Pool is shutting down, cannot acquire`);
      return null;
    }

    // Try to get available connection
    let connection = this.availableConnections.pop();
    console.log(`🔍 Popped connection from available pool: ${!!connection}`);

    // Validate connection health status
    while (connection) {
      if (connection.status === 'ready') {
        try {
          // Quick ping test to validate connection
          await Promise.race([
            connection.ping(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Ping timeout')), 500)
            )
          ]);
          
          this.connectionsInUse.add(connection);
          this.connectionLastUsed.set(connection, Date.now());
          return connection;
        } catch (err) {
          console.warn(`⚠️ Connection validation failed: ${err instanceof Error ? err.message : String(err)}`);
          this.removeConnection(connection);
        }
      } else {
        console.warn(`⚠️ Connection not ready (status: ${connection.status})`);
        this.removeConnection(connection);
      }
      
      // Try next connection
      connection = this.availableConnections.pop();
    }

    // If no available connections, try to create new connection
    if (this.connections.length < this.options.max) {
      console.log(`📈 No available connections, creating new one (${this.connections.length}/${this.options.max})`);
      try {
        await this.createConnection();
        connection = this.availableConnections.pop();
        if (connection) {
          console.log(`✅ New connection created and acquired`);
          this.connectionsInUse.add(connection);
          this.connectionLastUsed.set(connection, Date.now());
          return connection;
        }
      } catch (error) {
        console.error('❌ Failed to create new connection:', error);
      }
    } else {
      console.log(`⚠️ Max connections reached (${this.options.max}), waiting for available connection...`);
    }

    // Wait for connection to become available
    console.log(`⏳ Waiting for connection (timeout: ${this.options.acquireTimeout}ms)...`);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const index = this.waitingQueue.indexOf(resolve);
        if (index !== -1) {
          this.waitingQueue.splice(index, 1);
          console.warn(`⏱️ Connection acquire timeout after ${this.options.acquireTimeout}ms`);
          resolve(null);
        }
      }, this.options.acquireTimeout);

      this.waitingQueue.push((conn) => {
        clearTimeout(timeout);
        if (conn) {
          console.log(`✅ Got connection from queue`);
          this.connectionsInUse.add(conn);
          this.connectionLastUsed.set(conn, Date.now());
        }
        resolve(conn);
      });
    });
  }

  /**
   * Release connection back to pool
   */
  release(connection: Redis): void {
    if (!connection || !this.connectionsInUse.has(connection)) {
      return;
    }

    this.connectionsInUse.delete(connection);

    // If connection is still healthy, return to available pool
    if (connection.status === 'ready' && !this.isShuttingDown) {
      // If there are waiting requests, assign directly
      const waiting = this.waitingQueue.shift();
      if (waiting) {
        waiting(connection);
      } else {
        this.availableConnections.push(connection);
      }
    } else {
      // Unhealthy connection, remove and try to create new one
      this.removeConnection(connection);
      if (!this.isShuttingDown && this.connections.length < this.options.min) {
        this.createConnection().catch(err => {
          console.error('Failed to recreate connection:', err);
        });
      }
    }
  }

  /**
   * Handle connection error
   */
  private handleConnectionError(connection: Redis): void {
    // Remove from available connections
    const index = this.availableConnections.indexOf(connection);
    if (index !== -1) {
      this.availableConnections.splice(index, 1);
    }
  }

  /**
   * Remove connection
   */
  private removeConnection(connection: Redis): void {
    const connId = this.connectionIdMap.get(connection) || 0;
    
    const index = this.connections.indexOf(connection);
    if (index !== -1) {
      this.connections.splice(index, 1);
    }

    const availIndex = this.availableConnections.indexOf(connection);
    if (availIndex !== -1) {
      this.availableConnections.splice(availIndex, 1);
    }
    
    // Remove from in-use set
    this.connectionsInUse.delete(connection);
    
    // Clean up mappings
    this.connectionIdMap.delete(connection);
    this.connectionLastUsed.delete(connection);
    
    // Remove all event listeners to prevent memory leaks
    connection.removeAllListeners();

    // Try to close connection
    try {
      if (connection.status !== 'end' && connection.status !== 'close') {
        connection.disconnect(false);
      }
    } catch (err) {
      console.error(`Failed to disconnect connection #${connId}:`, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Health check and cleanup idle connections
   */
  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      const now = Date.now();
      const status = this.getStatus();

      // Detailed status logs
      console.log(`📊 Pool status: ${status.total} total, ${status.available} available, ${status.inUse} in use, ${status.healthy} healthy, ${status.waiting} waiting`);

      // Check health status of each connection
      for (const conn of this.connections) {
        const connId = this.connectionIdMap.get(conn) || 0;
        if (conn.status !== 'ready') {
          console.warn(`⚠️ Connection #${connId} is in ${conn.status} state`);
        }
      }

      // Check idle connections
      const idleConnections: Redis[] = [];
      this.availableConnections.forEach(conn => {
        const lastUsed = this.connectionLastUsed.get(conn) || 0;
        const idleTime = now - lastUsed;
        
        if (idleTime > this.options.idleTimeout && this.connections.length > this.options.min) {
          idleConnections.push(conn);
          const connId = this.connectionIdMap.get(conn) || 0;
          console.log(`♻️ Removing idle connection #${connId} (unused for ${Math.round(idleTime / 1000)}s)`);
        }
      });

      // Batch remove idle connections
      idleConnections.forEach(conn => this.removeConnection(conn));

      // Ensure minimum connections
      if (this.connections.length < this.options.min && !this.isShuttingDown) {
        const needed = this.options.min - this.connections.length;
        console.log(`📈 Need to create ${needed} connections to maintain minimum pool size`);

        // Create at most 1 connection per health check to avoid connection storms
        // If Redis has issues, will discover gradually rather than immediately creating many failed connections
        this.createConnection().catch(err => {
          console.error('Health check: Failed to create connection:', err instanceof Error ? err.message : String(err));
        });
      }

      // Perform ping test on healthy connections
      if (status.healthy > 0) {
        const testConn = this.availableConnections[0];
        if (testConn && testConn.status === 'ready') {
          try {
            const start = Date.now();
            await testConn.ping();
            const latency = Date.now() - start;
            console.log(`🏓 Redis ping latency: ${latency}ms`);
            
            if (latency > 100) {
              console.warn(`⚠️ High Redis latency detected: ${latency}ms`);
            }
          } catch (err) {
            console.error('❌ Ping test failed:', err instanceof Error ? err.message : String(err));
          }
        }
      }

      // If no healthy connections, emit warning
      if (status.healthy === 0 && !this.isShuttingDown) {
        console.error('🚨 No healthy Redis connections available!');
        this.emit('no-healthy-connections');
      }
    }, 30000); // Check every 30 seconds, reduce frequent checks
  }

  /**
   * Execute Redis command (with connection pool)
   */
  async execute<T>(fn: (redis: Redis) => Promise<T>): Promise<T | null> {
    console.log(`🎯 execute() called - acquiring connection...`);
    const connection = await this.acquire();
    if (!connection) {
      console.error('❌ Failed to acquire connection from pool');
      return null;
    }

    console.log(`✅ Connection acquired, executing command...`);
    try {
      const result = await fn(connection);
      console.log(`✅ Command executed successfully`);
      return result;
    } catch (error) {
      console.error('❌ Redis command error:', error);
      throw error;
    } finally {
      console.log(`🔄 Releasing connection back to pool`);
      this.release(connection);
    }
  }

  /**
   * Get pool status
   */
  getStatus() {
    return {
      total: this.connections.length,
      available: this.availableConnections.length,
      inUse: this.connections.length - this.availableConnections.length,
      waiting: this.waitingQueue.length,
      healthy: this.connections.filter(c => c.status === 'ready').length,
      min: this.options.min,
      max: this.options.max,
    };
  }

  /**
   * Shutdown connection pool
   */
  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down Redis connection pool...');
    this.isShuttingDown = true;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Clear waiting queue
    this.waitingQueue.forEach(resolve => resolve(null));
    this.waitingQueue = [];

    // Close all connections
    const promises = this.connections.map(conn => conn.quit());
    await Promise.allSettled(promises);

    this.connections = [];
    this.availableConnections = [];

    console.log('✅ Redis connection pool shut down');
  }
}

// Singleton connection pool
let poolInstance: RedisConnectionPool | null = null;

/**
 * Get or create connection pool
 */
export function getRedisPool(redisUrl?: string, options?: PoolOptions): RedisConnectionPool | null {
  if (!redisUrl) {
    console.warn('⚠️ No Redis URL provided');
    return null;
  }

  if (!poolInstance) {
    poolInstance = new RedisConnectionPool(redisUrl, options);
  }

  return poolInstance;
}

/**
 * Shutdown connection pool
 */
export async function shutdownPool(): Promise<void> {
  if (poolInstance) {
    await poolInstance.shutdown();
    poolInstance = null;
  }
}

export default RedisConnectionPool;

/**
 * Compatible interface for legacy RedisConnectionManager
 * Provides unified global connection pool access
 */
class RedisConnectionManager {
  private static globalPool: RedisConnectionPool | null = null;
  private static redisUrl: string | null = null;

  /**
   * Get or create connection (compatible legacy interface)
   * Returns a simulated Redis client that actually uses connection pool
   */
  static async getConnection(redisUrl?: string): Promise<any | null> {
    if (!redisUrl) {
      return null;
    }

    // Initialize global pool
    if (!this.globalPool) {
      this.redisUrl = redisUrl;

      // Read configuration from environment variables, use reasonable defaults
      const min = parseInt(process.env.REDIS_CONNECTION_POOL_MIN || '3', 10);
      const max = parseInt(process.env.REDIS_CONNECTION_POOL_MAX || '15', 10);

      this.globalPool = getRedisPool(redisUrl, {
        min,           // Read from environment variables
        max,           // Read from environment variables
        acquireTimeout: 5000,     // Connection acquisition timeout 5 seconds
        connectionTimeout: 30000, // Connection timeout 30 seconds
        idleTimeout: 300000,      // Idle timeout 5 minutes
        retryAttempts: 5,         // Retry 5 times (consistent with above configuration)
      });

      if (this.globalPool) {
        console.log('✅ Global Redis connection pool initialized for legacy compatibility');
      }
    }

    if (!this.globalPool) {
      return null;
    }

    // Return a proxy object that forwards all Redis commands to connection pool
    const pool = this.globalPool;
    return new Proxy({
      // Simulate status property
      get status() {
        const status = pool.getStatus();
        return status.healthy > 0 ? 'ready' : 'disconnected';
      }
    }, {
      get: (target: any, prop: string) => {
        // If it's status property, return target's status
        if (prop === 'status') {
          return target.status;
        }

        // Ignore then method to prevent being mistaken as Promise by await
        // This way await won't try to treat Proxy as Promise
        if (prop === 'then') {
          return undefined;
        }

        // Ignore other Promise-related properties
        if (prop === 'catch' || prop === 'finally') {
          return undefined;
        }

        // For multi() and pipeline(), we need special handling
        // Because they need to execute entire transaction on same connection
        if (prop === 'multi' || prop === 'pipeline') {
          return (...args: any[]) => {
            // Record all queued commands
            const commands: Array<{ method: string; args: any[] }> = [];

            // Create a recursive Proxy for chained calls
            const createChainProxy = (): any => {
              return new Proxy({}, {
                get: (_, chainProp: string | symbol) => {
                  const propStr = String(chainProp);

                  // exec() executes all recorded commands
                  if (propStr === 'exec') {
                    return async () => {
                      console.log(`🎯 Executing transaction with ${commands.length} commands`);
                      return await pool.execute(async (redis) => {
                        // Create transaction on real connection
                        const multi = (redis as any)[prop](...args);

                        // Replay all commands
                        for (const cmd of commands) {
                          console.log(`   📝 Queuing: ${cmd.method}(${cmd.args.join(', ')})`);
                          multi[cmd.method](...cmd.args);
                        }

                        // Execute transaction
                        console.log(`   ▶️ Executing transaction...`);
                        const result = await multi.exec();
                        console.log(`   ✅ Transaction executed, results: ${result?.length || 0}`);
                        return result;
                      });
                    };
                  }

                  // All other methods are recorded to command list and return self to support chaining
                  return (...methodArgs: any[]) => {
                    console.log(`📝 Recording transaction command: ${propStr}(${methodArgs.join(', ')})`);
                    commands.push({ method: propStr, args: methodArgs });
                    return createChainProxy(); // Return new Proxy to continue chaining
                  };
                }
              });
            };

            return createChainProxy();
          };
        }

        // All other methods are executed through pool
        return async (...args: any[]) => {
          return await pool.execute(async (redis) => {
            const method = (redis as any)[prop];
            if (typeof method === 'function') {
              return await method.apply(redis, args);
            }
            return null;
          });
        };
      }
    });
  }

  /**
   * Check if connected
   */
  static isConnected(): boolean {
    if (!this.globalPool) {
      return false;
    }
    const status = this.globalPool.getStatus();
    return status.healthy > 0;
  }

  /**
   * Disconnect
   */
  static async disconnect(): Promise<void> {
    if (this.globalPool) {
      await this.globalPool.shutdown();
      this.globalPool = null;
      this.redisUrl = null;
    }
  }

  /**
   * Force reconnect
   */
  static async reconnect(): Promise<any | null> {
    await this.disconnect();
    return this.redisUrl ? this.getConnection(this.redisUrl) : null;
  }
}

// Export compatible RedisConnectionManager
export { RedisConnectionManager };