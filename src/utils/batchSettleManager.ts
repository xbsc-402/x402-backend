/**
 * Batch Settle Manager
 * Manages batch submission of settle requests, implementing automatic nonce management and concurrent processing
 */

// Temporary type definitions (importing from x402 would be better, but simplified here)
type PaymentPayload = any;

export interface SettleItem {
  requestId: string;
  paymentPayload: PaymentPayload;
  paymentRequirements: any;
  timestamp: number;
}

export interface SettleResult {
  requestId: string;
  success: boolean;
  transaction?: string;
  nonce?: number;
  error?: string;
}

export interface BatchSettleOptions {
  batchSize?: number;        // Maximum number of transactions per batch
  batchTimeout?: number;      // Batch timeout (milliseconds)
  maxRetries?: number;        // Maximum retry count
  facilitatorUrl: string;     // Facilitator API address
}

/**
 * Batch Settle Manager
 */
export class BatchSettleManager {
  private queue: Map<string, SettleItem> = new Map();
  private pendingPromises: Map<string, {
    resolve: (result: SettleResult) => void;
    reject: (error: Error) => void;
  }> = new Map();
  
  private timer: NodeJS.Timeout | null = null;
  private processing = false;
  
  private readonly batchSize: number;
  private readonly batchTimeout: number;
  private readonly maxRetries: number;
  private readonly facilitatorUrl: string;

  constructor(options: BatchSettleOptions) {
    this.batchSize = options.batchSize || 10;
    this.batchTimeout = options.batchTimeout || 5000;
    this.maxRetries = options.maxRetries || 2;
    this.facilitatorUrl = options.facilitatorUrl;
    
    console.log(`✅ BatchSettleManager initialized:`);
    console.log(`   Batch size: ${this.batchSize}`);
    console.log(`   Batch timeout: ${this.batchTimeout}ms`);
    console.log(`   Max retries: ${this.maxRetries}`);
  }

  /**
   * Add a settle request to the queue
   */
  async addToQueue(
    requestId: string,
    paymentPayload: PaymentPayload,
    paymentRequirements: any
  ): Promise<SettleResult> {
    return new Promise((resolve, reject) => {
      // Add to queue
      this.queue.set(requestId, {
        requestId,
        paymentPayload,
        paymentRequirements,
        timestamp: Date.now(),
      });

      // Save promise callbacks
      this.pendingPromises.set(requestId, { resolve, reject });

      console.log(`📥 [${requestId}] Added to settle queue (queue size: ${this.queue.size})`);

      // Check if immediate processing is needed
      if (this.queue.size >= this.batchSize) {
        console.log(`🚀 Queue reached batch size (${this.batchSize}), flushing immediately`);
        this.flush();
      } else if (!this.timer) {
        // Set timeout
        this.timer = setTimeout(() => {
          console.log(`⏰ Batch timeout reached, flushing queue`);
          this.flush();
        }, this.batchTimeout);
      }
    });
  }

  /**
   * Immediately process all transactions in the queue
   */
  private async flush(): Promise<void> {
    // Clear timer
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Skip if processing or queue is empty
    if (this.processing || this.queue.size === 0) {
      return;
    }

    this.processing = true;

    // Extract current batch
    const batchItems = Array.from(this.queue.values()).slice(0, this.batchSize);
    const batchIds = batchItems.map(item => item.requestId);

    console.log(`\n🔄 Processing batch: ${batchItems.length} items`);
    console.log(`   Request IDs: ${batchIds.join(', ')}`);

    try {
      // Call facilitator batch settle
      const results = await this.batchSettle(batchItems);

      // Process each result
      for (const result of results) {
        const promise = this.pendingPromises.get(result.requestId);
        if (promise) {
          if (result.success) {
            promise.resolve(result);
            console.log(`✅ [${result.requestId}] Settled successfully: ${result.transaction?.substring(0, 10)}...`);
          } else {
            promise.reject(new Error(result.error || 'Settle failed'));
            console.error(`❌ [${result.requestId}] Settle failed: ${result.error}`);
          }
          
          // Cleanup
          this.queue.delete(result.requestId);
          this.pendingPromises.delete(result.requestId);
        }
      }

      console.log(`✅ Batch processed successfully\n`);
    } catch (error: any) {
      console.error(`❌ Batch processing failed:`, error.message);
      
      // All requests failed
      for (const item of batchItems) {
        const promise = this.pendingPromises.get(item.requestId);
        if (promise) {
          promise.reject(error);
          this.queue.delete(item.requestId);
          this.pendingPromises.delete(item.requestId);
        }
      }
    } finally {
      this.processing = false;

      // If there are remaining items, continue processing
      if (this.queue.size > 0) {
        console.log(`📦 Queue still has ${this.queue.size} items, scheduling next batch`);
        this.timer = setTimeout(() => this.flush(), 100);
      }
    }
  }

  /**
   * Call facilitator's batch settle interface
   */
  private async batchSettle(items: SettleItem[]): Promise<SettleResult[]> {
    const startTime = Date.now();
    
    console.log(`   📡 Step 1: Re-verifying ${items.length} payments before batch settle...`);
    
    // Batch verify all payments, filter out expired ones
    const verifyResults = await Promise.all(
      items.map(async (item) => {
        try {
          const verifyResponse = await fetch(`${this.facilitatorUrl}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              paymentPayload: item.paymentPayload,
              paymentRequirements: item.paymentRequirements,
            }),
          });
          
          if (!verifyResponse.ok) {
            return { item, valid: false, reason: `HTTP ${verifyResponse.status}` };
          }
          
          const result = await verifyResponse.json() as { isValid: boolean; invalidReason?: string };
          return { item, valid: result.isValid, reason: result.invalidReason };
        } catch (error: any) {
          return { item, valid: false, reason: error.message };
        }
      })
    );
    
    // Separate valid and invalid items
    const validItems = verifyResults.filter(r => r.valid).map(r => r.item);
    const invalidItems = verifyResults.filter(r => !r.valid);
    
    console.log(`   ✅ Valid: ${validItems.length}, ❌ Invalid: ${invalidItems.length}`);
    
    // If there are invalid ones, log them
    for (const { item, reason } of invalidItems) {
      console.log(`   ❌ [${item.requestId}] Verification failed: ${reason}`);
    }
    
    // If no valid items, return failure results directly
    if (validItems.length === 0) {
      return items.map(item => ({
        requestId: item.requestId,
        success: false,
        error: 'All payments failed verification',
      }));
    }
    
    console.log(`   📡 Step 2: Calling facilitator batch settle with ${validItems.length} valid items...`);
    console.log(`   URL: ${this.facilitatorUrl}/settle/batch`);

    const response = await fetch(`${this.facilitatorUrl}/settle/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: validItems.map(item => ({
          paymentPayload: item.paymentPayload,
          paymentRequirements: item.paymentRequirements,
        })),
        waitForConfirmation: true, // Wait for confirmation to ensure transaction is on-chain
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Facilitator batch settle failed: ${response.status} ${errorText}`);
    }

    const result = await response.json() as {
      success: boolean;
      results: Array<{
        index: number;
        success: boolean;
        transaction?: string;
        nonce: number;
        error?: string;
      }>;
      totalSubmitted: number;
      totalSuccess: number;
      totalFailed: number;
    };
    const duration = Date.now() - startTime;

    console.log(`   ✅ Facilitator responded in ${duration}ms`);
    console.log(`   📊 Batch settle result: Success=${result.totalSuccess}, Failed=${result.totalFailed}, Total=${result.totalSubmitted}`);

    // Build complete result list (including verify failures)
    const finalResults: SettleResult[] = [];
    
    // Create index mapping for validItems
    const validItemsMap = new Map(validItems.map((item, index) => [item.requestId, index]));
    
    console.log(`   🔄 Mapping results back to original ${items.length} requests...`);
    
    for (const item of items) {
      const validIndex = validItemsMap.get(item.requestId);
      
      if (validIndex !== undefined) {
        // This item is valid, use settle result
        const settleResult = result.results[validIndex];
        finalResults.push({
          requestId: item.requestId,
          success: settleResult.success,
          transaction: settleResult.transaction,
          nonce: settleResult.nonce,
          error: settleResult.error,
        });
        
        if (settleResult.success) {
          console.log(`   ✅ [${item.requestId}] Settled: ${settleResult.transaction?.substring(0, 20)}... (nonce: ${settleResult.nonce})`);
        } else {
          console.log(`   ❌ [${item.requestId}] Failed: ${settleResult.error}`);
        }
      } else {
        // This item failed during verify
        const invalidItem = invalidItems.find(inv => inv.item.requestId === item.requestId);
        finalResults.push({
          requestId: item.requestId,
          success: false,
          error: `Verification failed: ${invalidItem?.reason || 'unknown'}`,
        });
        console.log(`   ❌ [${item.requestId}] Verify failed: ${invalidItem?.reason || 'unknown'}`);
      }
    }
    
    console.log(`   📦 Final results: ${finalResults.filter(r => r.success).length} success, ${finalResults.filter(r => !r.success).length} failed`);
    
    return finalResults;
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      queueSize: this.queue.size,
      processing: this.processing,
      pendingPromises: this.pendingPromises.size,
      oldestItemAge: this.queue.size > 0 
        ? Date.now() - Math.min(...Array.from(this.queue.values()).map(i => i.timestamp))
        : 0,
    };
  }

  /**
   * Force process all pending transactions
   */
  async flushAll(): Promise<void> {
    console.log(`🔄 Force flushing all queued items...`);
    while (this.queue.size > 0 && !this.processing) {
      await this.flush();
    }
  }

  /**
   * Clean up timed-out requests
   */
  cleanupStale(maxAge: number = 60000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [requestId, item] of this.queue.entries()) {
      if (now - item.timestamp > maxAge) {
        console.log(`🗑️ Cleaning up stale request: ${requestId} (age: ${now - item.timestamp}ms)`);
        
        const promise = this.pendingPromises.get(requestId);
        if (promise) {
          promise.reject(new Error('Request timeout'));
          this.pendingPromises.delete(requestId);
        }
        
        this.queue.delete(requestId);
        cleaned++;
      }
    }

    return cleaned;
  }
}

// Singleton instance
let batchSettleManagerInstance: BatchSettleManager | null = null;

/**
 * Get BatchSettleManager singleton
 */
export function getBatchSettleManager(facilitatorUrl?: string): BatchSettleManager {
  if (!batchSettleManagerInstance && facilitatorUrl) {
    batchSettleManagerInstance = new BatchSettleManager({
      batchSize: parseInt(process.env.SETTLE_BATCH_SIZE || '10', 10),
      batchTimeout: parseInt(process.env.SETTLE_BATCH_TIMEOUT || '5000', 10),
      maxRetries: parseInt(process.env.SETTLE_MAX_RETRIES || '2', 10),
      facilitatorUrl,
    });

    // Periodically clean up timed-out requests
    setInterval(() => {
      const cleaned = batchSettleManagerInstance!.cleanupStale(120000); // 2 minute timeout
      if (cleaned > 0) {
        console.log(`🧹 Cleaned up ${cleaned} stale requests`);
      }
    }, 30000); // Check every 30 seconds
  }

  if (!batchSettleManagerInstance) {
    throw new Error('BatchSettleManager not initialized. Provide facilitatorUrl on first call.');
  }

  return batchSettleManagerInstance;
}

/**
 * Shutdown BatchSettleManager
 */
export async function shutdownBatchSettleManager(): Promise<void> {
  if (batchSettleManagerInstance) {
    console.log('🛑 Shutting down BatchSettleManager...');
    await batchSettleManagerInstance.flushAll();
    batchSettleManagerInstance = null;
    console.log('✅ BatchSettleManager shut down');
  }
}

