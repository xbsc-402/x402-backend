import express, { type Request, type Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import {
  type Address,
  type Hex,
  parseUnits,
} from 'viem';
import { bsc } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { exact } from 'x402/schemes';
import { settleResponseHeader } from 'x402/types';
import type { PaymentPayload } from 'x402/types';
// No longer using Thirdweb SDK, using HTTP API instead
import { getBatchSettleManager, shutdownBatchSettleManager } from './utils/batchSettleManager.js';
import { TokenCapacityManager, TokenDeadlineCache } from './utils/tokenCapacityManager.js';

// Load environment variables
dotenv.config();

// ==================== Configuration ====================

const PORT = process.env.PORT || 3001;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Payment Chain: BSC Mainnet (for x402 payment collection)
const PAYMENT_CHAIN = bsc;
// Note: PAYMENT_RPC_URL not needed - facilitator handles payment chain RPC

// Mint Chain: BSC Testnet (for token minting)
const MINT_CHAIN = bsc;

// x402 Payment Configuration
const PAYMENT_TOKEN_ADDRESS = '0x2CBa817f6e3Ca58ff702Dc66feEEcb230A2EF349' as Address; // USD4 on BSC Mainnet
const PAYMENT_TOKEN_NAME = 'USD4'; // Token name for EIP-712 domain
// Note: x402 protocol limits value to 18 characters max
// For 6 decimal tokens, max is 999999999999 (12 chars)
const MINT_PRICE_USDT = parseUnits('10', 6); // 10 USD4 per mint request (1000000 wei = 7 chars)

// Validate environment variables
if (!process.env.MINTER_PRIVATE_KEY) {
  throw new Error('MINTER_PRIVATE_KEY is required');
}

// ==================== Local Facilitator HTTP API Configuration ====================

const FACILITATOR_API_URL = process.env.FACILITATOR_API_URL || 'http://localhost:3002';
console.log(`🔗 Using facilitator: ${FACILITATOR_API_URL}`);

// ==================== Blockchain Clients ====================

const account = privateKeyToAccount(process.env.MINTER_PRIVATE_KEY as Hex);

// Payment Chain: BSC Mainnet
// Note: Payment verification is handled by local facilitator via HTTP API
// No client needed here - facilitator will create its own clients

// Mint Chain Clients (BSC Testnet) - for token minting
// const mintPublicClient = createPublicClient({
//   chain: MINT_CHAIN,
//   transport: http(MINT_RPC_URL),
// });

// ==================== Token Capacity Manager ====================

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const tokenCapacityManager = new TokenCapacityManager(MINT_CHAIN, REDIS_URL);
console.log(`✅ TokenCapacityManager initialized with Redis: ${REDIS_URL}`);

const tokenDeadlineCache = new TokenDeadlineCache(MINT_CHAIN);
console.log(`✅ TokenDeadlineCache initialized`);

// ==================== Abuse Detection ====================

import { AbuseDetector, createIdentifier } from './utils/abuseDetector.js';

const abuseDetector = new AbuseDetector(REDIS_URL, {
  maxRequestsPerWindow: parseInt(process.env.ABUSE_MAX_REQUESTS || '10', 10),
  timeWindowMs: parseInt(process.env.ABUSE_TIME_WINDOW_MS || '3000', 10), // 3 seconds (strict)
  banDurationMs: parseInt(process.env.ABUSE_BAN_DURATION_MS || '3600000', 10), // 1 hour
});
console.log(`🛡️  AbuseDetector initialized`);

// ====================  Payment Verification ====================

/**
 * Verify payment using Local Facilitator HTTP API
 */
const verify = async (paymentPayload: PaymentPayload, paymentRequirements: any) => {
  const requestTime = new Date().toISOString();
  console.log(`\n⏰ [${requestTime}] Facilitator Verify Request`);
  console.log(`   From: ${(paymentPayload.payload as any).authorization.from}`);
  console.log(`   Nonce: ${(paymentPayload.payload as any).authorization.nonce}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout
  
  try {
    const response = await fetch(`${FACILITATOR_API_URL}/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        paymentPayload,
        paymentRequirements,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    
    const responseData = await response.json() as any;

  if (!response.ok) {
    console.error(`❌ [${requestTime}] Facilitator Verify Failed:`);
    console.error(`   Status: ${response.status}`);
    console.error(`   Error: ${JSON.stringify(responseData, null, 2)}`);
    // Extract error message from the correct field (facilitator uses 'message', not 'errorMessage')
    const errorMessage = responseData.message || responseData.error || responseData.errorMessage || `Verify failed: ${response.statusText}`;
    const error: any = new Error(errorMessage);
    // Preserve additional error details for proper handling
    error.reason = responseData.reason;
    error.details = responseData;
    throw error;
  }

  console.log(`✅ [${requestTime}] Facilitator Verify Success`);
  return responseData;
  } catch (error: any) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      console.error(`⏱️ [${requestTime}] Facilitator Verify Timeout after 30s`);
      throw new Error('Facilitator verify timeout');
    }
    throw error;
  }
};

/**
 * Settle payment using Local Facilitator HTTP API (deprecated - now using batch settle)
 * Kept for reference and potential fallback
 */
// @ts-ignore - kept for reference
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const settle = async (paymentPayload: PaymentPayload, paymentRequirements: any) => {
  const requestTime = new Date().toISOString();
  console.log(`\n⏰ [${requestTime}] Facilitator Settle Request`);
  console.log(`   From: ${(paymentPayload.payload as any).authorization.from}`);
  console.log(`   Nonce: ${(paymentPayload.payload as any).authorization.nonce}`);
  console.log(`   Amount: ${(paymentPayload.payload as any).authorization.value}`);

  // Retry configuration
  const maxRetries = 3;
  const retryDelay = 2000; // 2 second initial delay
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout (settle needs more time)
    
    try {
      const response = await fetch(`${FACILITATOR_API_URL}/settle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          paymentPayload,
          paymentRequirements,
          waitUntil: 'confirmed', // Wait for on-chain confirmation
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const responseData = await response.json() as any;

      if (!response.ok) {
        // Check if it's a timeout error
        const isTimeoutError = responseData.error?.includes('WaitForTransactionReceiptTimeoutError') || 
                              responseData.message?.includes('WaitForTransactionReceiptTimeoutError');
        
        if (isTimeoutError && attempt < maxRetries) {
          console.warn(`⏱️ [${requestTime}] Settle timeout on attempt ${attempt}/${maxRetries}, retrying in ${retryDelay * attempt}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
          continue; // Continue to next retry
        }
        
        console.error(`❌ [${requestTime}] Facilitator Settle Failed:`);
        console.error(`   Status: ${response.status}`);
        console.error(`   Error: ${JSON.stringify(responseData, null, 2)}`);
        // Extract error message from the correct field (facilitator uses 'message', not 'errorMessage')
        const errorMessage = responseData.message || responseData.error || responseData.errorMessage || `Settle failed: ${response.statusText}`;
        const error: any = new Error(errorMessage);
        // Preserve additional error details for proper handling
        error.reason = responseData.reason;
        error.details = responseData;
        error.activeTransactions = responseData.activeTransactions;
        error.maxCapacity = responseData.maxCapacity;
        throw error;
      }

      console.log(`✅ [${requestTime}] Facilitator Settle Success (attempt ${attempt}/${maxRetries})`);
      console.log(`   Transaction: ${responseData.transaction}`);
      return responseData;
      
    } catch (error: any) {
      clearTimeout(timeout);
      
      // Handle timeout errors
      if (error.name === 'AbortError') {
        console.error(`⏱️ [${requestTime}] Facilitator Settle Timeout on attempt ${attempt}/${maxRetries}`);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
          continue;
        }
        throw new Error('Facilitator settle timeout after all retries');
      }
      
      // Network error or other exceptions
      if (attempt < maxRetries) {
        console.warn(`🔄 [${requestTime}] Settle error on attempt ${attempt}/${maxRetries}: ${error.message}`);
        console.warn(`   Retrying in ${retryDelay * attempt}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        continue;
      }
      // Last attempt failed, throw error
      throw error;
    }
  }
};

console.log(`\n🔗 x402 Payment Architecture (Same-Chain Payment & Mint)`);
console.log(`📍 Payment Chain: ${PAYMENT_CHAIN.name} (ChainID: ${PAYMENT_CHAIN.id})`);
console.log(`📍 Mint Chain: ${MINT_CHAIN.name} (ChainID: ${MINT_CHAIN.id})`);
console.log(`🔑 Backend wallet address: ${account.address}`);
console.log(`💰 Payment Token (BSC Mainnet): ${PAYMENT_TOKEN_NAME} (${PAYMENT_TOKEN_ADDRESS})`);
console.log(`🎯 Mint Token: Dynamic (specified per request on BSC Testnet)`);
console.log(`💵 Mint price: 0.1 WUSDT`);
console.log(`🤝 x402 Facilitator: Local HTTP API (${FACILITATOR_API_URL})\n`);

// ==================== Express App ====================

const app: express.Express = express();

// Middleware
app.use(express.json());
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or postman)
      if (!origin) return callback(null, true);

      // Allow all localhost requests (any port)
      if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
        return callback(null, true);
      }

      // Allow all origins for now (you can restrict this later)
      return callback(null, true);
    },
    credentials: true, // Allow cookies and credentials
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Payment', 'x-payment'],
    // Expose x402 headers to frontend (must match actual header names - lowercase)
    exposedHeaders: ['x-payment-options', 'x-payment-response', 'X-Payment-Options', 'X-Payment-Response'],
  })
);

// Handle OPTIONS preflight requests explicitly
app.options('*', (req, res) => {
  console.log(`${new Date().toISOString()} OPTIONS ${req.path} - Preflight request handled`);
  res.sendStatus(204); // No Content
});

// Request logging
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Note: Deduplication disabled - x402 protocol has built-in replay protection via nonce
// Address cooldown (3s) is sufficient to prevent abuse

// ==================== Helper Functions ====================

/**
 * Timeout wrapper for promises
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]);
}


// ==================== API Endpoints ====================

/**
 * Health check endpoint handler
 */
const healthCheckHandler = (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    backend: account.address,
    paymentChain: PAYMENT_CHAIN.name,
    paymentChainId: PAYMENT_CHAIN.id,
    mintChain: MINT_CHAIN.name,
    mintChainId: MINT_CHAIN.id,
    mintContract: 'Dynamic (specified per request)',
    paymentToken: PAYMENT_TOKEN_ADDRESS,
    paymentTokenName: PAYMENT_TOKEN_NAME,
    mintPrice: '0.1 WUSDT',
    facilitator: FACILITATOR_API_URL,
    mode: 'x402 Payment (BSC Mainnet WUSDT → BSC Testnet Mint)',
    features: {
      capacityManager: 'enabled',
      batchMinting: 'enabled',
      nonceProtection: 'x402-eip3009',
    },
  });
};

/**
 * Health check endpoints (both /health and /api/health for Railway compatibility)
 */
app.get('/health', healthCheckHandler);
app.get('/api/health', healthCheckHandler);

/**
 * Shared mint handler function (used by both public and hidden endpoints)
 * @param skipRateLimit - If true, skip the 3s/10 requests rate limit check
 * @param requireWhitelist - If true, only allow whitelisted IPs
 */
async function handleMintRequest(req: Request, res: Response, skipRateLimit: boolean = false, requireWhitelist: boolean = false) {
  const handlerRequestId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  console.log(`🎯 [${handlerRequestId}] /api/mint handler started`);
  console.log(`🎯 [${handlerRequestId}] Request body:`, JSON.stringify(req.body));
  console.log(`🎯 [${handlerRequestId}] Has X-PAYMENT header:`, !!req.headers['x-payment']);

  try {
    // ==================== Step 0: Whitelist Check (if required) ====================
    if (requireWhitelist) {
      const clientIP = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || 
                       (req.headers['x-real-ip'] as string) || 
                       req.socket.remoteAddress || 
                       'unknown';
      const identifier = createIdentifier(undefined, clientIP);
      
      // Check whitelist
      const stats = await abuseDetector.getStats(identifier);
      if (!stats.isWhitelisted) {
        console.log(`🚫 [${handlerRequestId}] Access denied: ${identifier} is not whitelisted`);
        return res.status(403).json({
          error: 'Access denied',
          message: 'This endpoint is only accessible to whitelisted IPs',
        });
      }
      console.log(`✅ [${handlerRequestId}] Whitelist check passed: ${identifier}`);
    }

    const { recipients, tokenAddress: rawTokenAddress } = req.body;
    const paymentHeader = req.headers['x-payment'] as string | undefined;

    // Trim tokenAddress to prevent whitespace/newline issues
    const tokenAddress = rawTokenAddress?.trim();

    // Validate request parameters
    if (!tokenAddress) {
      console.log(`❌ [${handlerRequestId}] Missing tokenAddress, returning 400`);
      return res.status(400).json({
        error: 'Missing required field: tokenAddress',
      });
    }

    if (!recipients || !Array.isArray(recipients)) {
      console.log(`❌ [${handlerRequestId}] Invalid recipients, returning 400`);
      return res.status(400).json({
        error: 'Missing required field: recipients',
      });
    }

    if (recipients.length === 0 || recipients.length > 100) {
      console.log(`❌ [${handlerRequestId}] Invalid recipients length: ${recipients.length}, returning 400`);
      return res.status(400).json({
        error: 'Recipients must be between 1 and 100 addresses',
      });
    }

    // ==================== Step 0.5: Check Token Deployment Deadline ====================
    try {
      const deadline = await tokenDeadlineCache.getDeploymentDeadline(tokenAddress as Address);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const difference = Number(deadline - now); // Remaining seconds (matches frontend logic)
      
      if (difference <= 0) {
        // Token expired - record abuse and ban if > 5 requests
        const clientIP = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || 
                         (req.headers['x-real-ip'] as string) || 
                         req.socket.remoteAddress || 
                         'unknown';
        const expiredTokenIdentifier = createIdentifier(undefined, `${clientIP}:expired`);
        
        // Custom abuse detection for expired tokens (5 requests per hour)
        const expiredCheck = await abuseDetector.recordRequest(expiredTokenIdentifier);
        
        if (!expiredCheck.allowed) {
          // IP banned for repeated expired token requests - silent rejection
          return res.status(410).json({
            error: 'Token deployment period has ended',
            tokenAddress,
          });
        }
        
        // First few requests - return error without verbose logging
        return res.status(410).json({
          error: 'Token deployment period has ended',
          message: `This token's deployment deadline has passed`,
          tokenAddress,
          remainingTime: difference,
        });
      }
      
      const remainingMinutes = Math.floor(difference / 60);
      console.log(`✅ Token deadline OK: ${remainingMinutes} minutes remaining`);
    } catch (error: any) {
      console.error(`❌ Failed to check deployment deadline:`, error.message);
      // If we can't check deadline, continue anyway (fail open)
    }

    // ==================== Step 1: Check for Payment ====================

    if (!paymentHeader) {
      // No payment provided - Return 402 Payment Required
      console.log(`💳 [${handlerRequestId}] Payment required for mint request`);
      console.log(`   Mint Token (BSC Testnet): ${tokenAddress}`);
      console.log(`   Recipients: ${recipients.length}`);

      // Build x402 payment requirements
      // Payment goes to the token contract address
      const paymentRequirements = {
        payTo: tokenAddress as Address,
        scheme: 'exact' as const,
        network: 'bsc', // BSC Mainnet
        token: PAYMENT_TOKEN_ADDRESS as Address,
        amount: MINT_PRICE_USDT.toString(),
      };

      // Return 402 Payment Required with X-PAYMENT-OPTIONS header
      // Format: scheme="exact", network="bsc", token="0x...", payee="0x...", amount="1000000000000000"
      const paymentOptionsHeader = `scheme="${paymentRequirements.scheme}", network="${paymentRequirements.network}", token="${paymentRequirements.token}", payee="${paymentRequirements.payTo}", amount="${paymentRequirements.amount}"`;

      console.log(`📤 [${handlerRequestId}] Setting X-Payment-Options header: ${paymentOptionsHeader}`);
      res.setHeader('X-Payment-Options', paymentOptionsHeader);

      console.log(`📤 [${handlerRequestId}] Response headers:`, res.getHeaders());

      console.log(`📤 [${handlerRequestId}] Returning 402 Payment Required`);
      return res.status(402).json({
        error: 'Payment required',
        message: 'Please include X-PAYMENT header with signed authorization',
        paymentRequired: {
          price: '10 USD4',
          amount: MINT_PRICE_USDT.toString(), // Raw amount for x402 client
          payTo: tokenAddress,
          token: PAYMENT_TOKEN_ADDRESS,
          tokenName: PAYMENT_TOKEN_NAME,
          tokenVersion: '1', // EIP-712 domain version
          network: 'bsc',
        },
      });
    }

    // ==================== Step 2: Verify Payment with Facilitator ====================

    console.log(`🔍 Verifying payment with facilitator...`);
    console.log(`   Facilitator: Local HTTP API (${FACILITATOR_API_URL})`);

    // Decode payment from header
    let decodedPayment: PaymentPayload;
    try {
      decodedPayment = exact.evm.decodePayment(paymentHeader);
      console.log(`   ✅ Payment header decoded successfully`);
    } catch (error: any) {
      console.error(`   ❌ Failed to decode payment header:`, error.message);
      return res.status(400).json({
        error: 'Invalid payment format',
        details: error.message,
      });
    }

    // Build payment requirements for verification
    const paymentRequirements = {
      scheme: 'exact' as const,
      network: 'bsc' as const, // BSC Mainnet
      maxAmountRequired: MINT_PRICE_USDT.toString(),
      resource: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
      description: 'Token mint payment',
      mimeType: 'application/json',
      payTo: tokenAddress as Address,
      maxTimeoutSeconds: 600,
      asset: PAYMENT_TOKEN_ADDRESS as Address,
      extra: {
        name: PAYMENT_TOKEN_NAME, // 'USD4'
        version: '1', // EIP-712 domain version
      },
    };

    console.log(`   Payment requirements:`, {
      network: paymentRequirements.network,
      amount: paymentRequirements.maxAmountRequired,
      payTo: paymentRequirements.payTo,
      asset: paymentRequirements.asset,
    });

    // Get client IP for abuse detection (extracted early for use in verify failure)
    const clientIP = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || 
                     (req.headers['x-real-ip'] as string) || 
                     req.socket.remoteAddress || 
                     'unknown';
    const abuseIdentifier = createIdentifier(undefined, clientIP);

    // Verify payment with facilitator (with 30s timeout)
    let verifyResponse;
    try {
      console.log(`   📡 Calling facilitator verify endpoint...`);
      console.log(`   📦 Decoded payment:`, JSON.stringify(decodedPayment, null, 2));

      verifyResponse = await withTimeout(
        verify(decodedPayment, paymentRequirements),
        60000, // 1 minute timeout (increased to accommodate slow networks)
        'Facilitator verify'
      );
      console.log(`   ✅ Facilitator verify response received:`, JSON.stringify(verifyResponse, null, 2));
    } catch (error: any) {
      console.error(`   ❌ Facilitator verify error:`, error.message);
      console.error(`   ❌ Error stack:`, error.stack);
      console.error(`   ❌ Full error object:`, JSON.stringify(error, Object.getOwnPropertyNames(error), 2));

      // Record abuse for verify errors (3 failures = ban)
      console.log(`🛡️  Recording verify failure for abuse detection: ${abuseIdentifier}`);
      await abuseDetector.recordRequest(abuseIdentifier);

      // Handle capacity exceeded error specially
      if (error.reason === 'mempool_capacity_exceeded') {
        return res.status(402).json({
          error: 'Payment verification failed',
          reason: 'mempool_capacity_exceeded',
          message: error.message,
          details: {
            activeTransactions: error.details?.activeTransactions,
            maxCapacity: error.details?.maxCapacity,
            facilitator: FACILITATOR_API_URL
          }
        });
      }

      return res.status(500).json({
        error: 'Failed to verify payment with facilitator',
        reason: error.reason,
        details: error.message,
        facilitator: FACILITATOR_API_URL,
        errorType: error.constructor.name,
      });
    }

    if (!verifyResponse.isValid) {
      // Use 'reason' field instead of 'invalidReason' (facilitator returns 'reason')
      console.log(`❌ Payment verification failed: ${verifyResponse.reason || verifyResponse.invalidReason || 'Unknown reason'}`);
      
      // Record abuse for invalid payments (3 failures = ban)
      console.log(`🛡️  Recording invalid payment for abuse detection: ${abuseIdentifier}`);
      await abuseDetector.recordRequest(abuseIdentifier);

      return res.status(402).json({
        error: 'Payment verification failed',
        reason: verifyResponse.reason || verifyResponse.invalidReason,
        message: verifyResponse.message,
        details: verifyResponse.reason === 'mempool_capacity_exceeded' ? {
          activeTransactions: verifyResponse.activeTransactions,
          maxCapacity: verifyResponse.maxCapacity
        } : undefined
      });
    }

    console.log(`✅ Payment verified successfully`);

    // ==================== Step 3: Abuse Detection (Rate Limiting for Valid Payments) ====================
    
    // clientIP and abuseIdentifier already defined above (before verify)
    const payerAddress = (decodedPayment.payload as any).authorization.from;
    
    // Skip rate limiting if this is the hidden endpoint
    if (!skipRateLimit) {
      console.log(`🛡️  Checking rate limit for valid payment: ${abuseIdentifier}`);
      const abuseCheck = await abuseDetector.recordRequest(abuseIdentifier);
      
      if (!abuseCheck.allowed) {
        console.log(`🚫 Request blocked by rate limiter: ${abuseCheck.reason}`);
        return res.status(429).json({
          error: 'Too many requests',
          message: abuseCheck.reason,
          address: payerAddress,
          retryAfter: 3600, // Suggest retry after 1 hour
        });
      }
      
      console.log(`✅ Rate limit check passed`);
    } else {
      console.log(`🔓 Rate limiting skipped (hidden endpoint)`);
    }

    // ==================== Step 4: Check Mint Capacity BEFORE Settlement ====================
    
    console.log(`🔍 Checking mint capacity before settlement...`);
    try {
      const capacityInfo = await tokenCapacityManager.checkCapacity(
        tokenAddress as Address,
        recipients.length
      );
      
      console.log(`✅ Capacity check passed:
         Available: ${capacityInfo.availableSlots}
         Requested: ${recipients.length}
         Current: ${capacityInfo.currentMintCount}/${capacityInfo.maxMintCount}
         Pending: ${capacityInfo.pendingCount}`);
    } catch (error: any) {
      if (error.code === 'CAPACITY_EXCEEDED') {
        console.log(`❌ [${handlerRequestId}] Mint capacity exceeded, returning 429`);
        const capacityInfo = error.capacityInfo;
        return res.status(429).json({
          error: 'Mint capacity exceeded',
          message: 'Token has reached or will exceed maximum mint limit',
          current: capacityInfo.currentMintCount,
          pending: capacityInfo.pendingCount,
          max: capacityInfo.maxMintCount,
          requested: recipients.length,
          available: capacityInfo.availableSlots,
          retryAfter: null // Indicates should not retry
        });
      }
      
      console.error(`❌ Capacity check failed:`, error.message);
      return res.status(503).json({
        error: 'Failed to check mint capacity',
        message: 'Unable to verify available mint slots',
        reason: error.message
      });
    }

    // ==================== Step 5: Reserve Capacity ====================
    
    console.log(`🔒 Reserving capacity for ${recipients.length} mints...`);
    let capacityReserved = false;
    
    try {
      await tokenCapacityManager.reserveCapacity(
        tokenAddress as Address,
        recipients.length
      );
      capacityReserved = true;
      console.log(`✅ Capacity reserved successfully`);
    } catch (error: any) {
      console.error(`❌ Failed to reserve capacity:`, error.message);
      return res.status(503).json({
        error: 'Failed to reserve mint capacity',
        message: 'Unable to reserve mint slots',
        reason: error.message
      });
    }

    // ==================== Step 6: Settle Payment (after capacity check) ====================

    console.log(`💰 Settling payment with facilitator (using batch queue)...`);

    let settleResponse;
    try {
      console.log(`   📡 Adding to batch settle queue...`);
      
      // Use batch settle manager
      const batchManager = getBatchSettleManager(FACILITATOR_API_URL);
      const settleResult = await withTimeout(
        batchManager.addToQueue(handlerRequestId, decodedPayment, paymentRequirements),
        180000, // 3 minute timeout (blockchain transaction confirmation needs more time)
        'Batch settle'
      );
      
      // Convert to settle response format
      settleResponse = {
        success: true,
        transaction: settleResult.transaction || '',
        network: 'bsc',
        payer: (decodedPayment.payload as any).authorization.from,
      } as any; // Temporarily use any, as our return format differs slightly from x402 standard
      
      console.log(`   ✅ Batch settle completed`);
      console.log(`   📊 Queue status:`, batchManager.getStatus());
    } catch (error: any) {
      console.error(`   ❌ Batch settle error:`, error.message);
      console.error(`   ❌ Error reason:`, error.reason);
      console.error(`   ❌ Error details:`, error.details);

      // Handle capacity exceeded error specially
      if (error.reason === 'mempool_capacity_exceeded') {
        // Release reserved capacity
        if (capacityReserved) {
          await tokenCapacityManager.releaseCapacity(tokenAddress as Address, recipients.length);
          console.log(`🔓 Released reserved capacity due to mempool_capacity_exceeded`);
        }
        return res.status(400).json({
          error: 'Payment settlement failed',
          reason: 'mempool_capacity_exceeded',
          message: error.message,
          details: {
            activeTransactions: error.activeTransactions,
            maxCapacity: error.maxCapacity,
            facilitator: FACILITATOR_API_URL
          }
        });
      }

      // Handle chain query failure
      if (error.reason === 'chain_query_failed') {
        // Release reserved capacity
        if (capacityReserved) {
          await tokenCapacityManager.releaseCapacity(tokenAddress as Address, recipients.length);
          console.log(`🔓 Released reserved capacity due to chain_query_failed`);
        }
        return res.status(503).json({
          error: 'Payment settlement failed',
          reason: 'chain_query_failed',
          message: error.message,
          facilitator: FACILITATOR_API_URL,
        });
      }

      // Release reserved capacity for any other error
      if (capacityReserved) {
        await tokenCapacityManager.releaseCapacity(tokenAddress as Address, recipients.length);
        console.log(`🔓 Released reserved capacity due to settle error`);
      }
      return res.status(500).json({
        error: 'Failed to settle payment with facilitator',
        reason: error.reason,
        details: error.message,
        facilitator: FACILITATOR_API_URL,
      });
    }

    // Check for explicit failure (facilitator may return different response structures)
    if (settleResponse.success === false || settleResponse.error) {
      console.error(`❌ Payment settlement failed: ${settleResponse.errorReason || settleResponse.reason || settleResponse.error}`);
      // Release reserved capacity
      if (capacityReserved) {
        await tokenCapacityManager.releaseCapacity(tokenAddress as Address, recipients.length);
        console.log(`🔓 Released reserved capacity due to settlement failure`);
      }
      return res.status(402).json({
        error: 'Payment settlement failed',
        reason: settleResponse.errorReason || settleResponse.reason,
        message: settleResponse.message || 'Payment must be settled before minting',
        details: settleResponse.details
      });
    }

    // Check if transaction ID is present (indicating success)
    if (!settleResponse.transaction && !settleResponse.transactionId && !settleResponse.transactionHash) {
      console.error(`❌ Payment settlement response missing transaction ID`);
      // Release reserved capacity
      if (capacityReserved) {
        await tokenCapacityManager.releaseCapacity(tokenAddress as Address, recipients.length);
        console.log(`🔓 Released reserved capacity due to invalid settlement response`);
      }
      return res.status(500).json({
        error: 'Invalid settlement response',
        message: 'Settlement response missing transaction ID',
        response: settleResponse
      });
    }

    // Note: Payment is already confirmed because we use waitUntil: 'confirmed' in facilitator config
    const paymentTxId = settleResponse.transaction || settleResponse.transactionId || settleResponse.transactionHash;
    console.log(`✅ Payment settled and confirmed on-chain`);
    console.log(`   Transaction ID: ${paymentTxId}`);

    // ==================== Step 7: Payment Settled Successfully ====================
    // Business logic changed: No longer performing mints after payment settlement
    // Release the reserved capacity since we're not minting

    if (capacityReserved) {
      await tokenCapacityManager.releaseCapacity(tokenAddress as Address, recipients.length);
      console.log(`🔓 Released reserved capacity - no mint operation`);
    }

    console.log(`✅ Payment settled successfully without mint operation`);

    // Return success response
    res.setHeader('X-PAYMENT-RESPONSE', settleResponseHeader(settleResponse));

    return res.json({
      success: true,
      paymentTxHash: paymentTxId,
      paymentChain: PAYMENT_CHAIN.name,
      paymentChainId: PAYMENT_CHAIN.id,
      recipients: recipients.length,
      message: 'Payment settled successfully',
    });
  } catch (error: any) {
    console.error('Mint error:', error);

    // Check for specific contract errors
    if (error.message?.includes('AlreadyMinted')) {
      return res.status(400).json({ error: 'Some recipients have already minted' });
    }

    if (error.message?.includes('MaxMintCountExceeded')) {
      return res.status(400).json({ error: 'Maximum mint count exceeded' });
    }

    return res.status(500).json({
      error: 'Failed to execute mint',
      details: IS_PRODUCTION ? undefined : error.message,
    });
  }
}

/**
 * POST /api/mint
 * Public mint endpoint (no whitelist requirement, no rate limit)
 */
app.post('/api/mint', async (req: Request, res: Response) => {
  return handleMintRequest(req, res, false, false); // skipRateLimit=false, requireWhitelist=false
});

/**
 * POST /api/internal/mint/7f3a9b2c8e1d4f6a
 * Hidden mint endpoint WITHOUT rate limiting and WITHOUT whitelist check
 * Same functionality as /api/mint but:
 * - No 3s/10 requests rate limit
 * - No whitelist requirement (path secrecy is the protection)
 * Keep this path secret!
 */
app.post('/api/internal/mint/7f3a9b2c8e1d4f6a', async (req: Request, res: Response) => {
  return handleMintRequest(req, res, true, false); // skipRateLimit=true, requireWhitelist=false
});

/**
 * GET /api/stats
 * Get concurrency control statistics
 */



/**
 * GET /api/payment/health
 * Check x402 facilitator connectivity
 */
app.get('/api/payment/health', async (_req: Request, res: Response) => {
  try {
    // Try to ping the local facilitator
    const response = await fetch(`${FACILITATOR_API_URL}/health`).catch(() => null);

    if (response && response.ok) {
      const data = await response.json();
      return res.json({
        status: 'ok',
        facilitator: FACILITATOR_API_URL,
        facilitatorStatus: data,
        message: 'x402 payment system operational (Local facilitator)',
      });
    } else {
      return res.status(503).json({
        status: 'error',
        facilitator: FACILITATOR_API_URL,
        message: 'Local facilitator is not reachable',
      });
    }
  } catch (error: any) {
    console.error('Payment health check error:', error);
    return res.status(500).json({
      error: 'Payment system health check failed',
      details: IS_PRODUCTION ? undefined : error.message,
    });
  }
});

/**
 * GET /api/redis/health
 * Check Redis connectivity
 */
app.get('/api/redis/health', async (_req: Request, res: Response) => {
  try {
    // Import RedisConnectionManager
    const { RedisConnectionManager } = await import('./utils/redisConnectionPool.js');

    const isConnected = RedisConnectionManager.isConnected();

    return res.status(isConnected ? 200 : 503).json({
      status: isConnected ? 'healthy' : 'unhealthy',
      connected: isConnected,
      message: isConnected
        ? 'Redis connection is active and ready'
        : 'Redis is not connected or not ready'
    });
  } catch (error: any) {
    console.error('Redis health check error:', error);
    return res.status(500).json({
      error: 'Redis health check failed',
      details: IS_PRODUCTION ? undefined : error.message,
    });
  }
});

/**
 * GET /api/capacity/:tokenAddress
 * Get token mint capacity status
 */
app.get('/api/capacity/:tokenAddress', async (req: Request, res: Response) => {
  try {
    const { tokenAddress } = req.params;
    
    if (!tokenAddress || !tokenAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      return res.status(400).json({
        error: 'Invalid token address',
        message: 'Token address must be a valid Ethereum address',
      });
    }

    // Check if token is expired - track abuse for repeated queries on expired tokens
    try {
      const deadline = await tokenDeadlineCache.getDeploymentDeadline(tokenAddress as Address);
      const now = BigInt(Math.floor(Date.now() / 1000));
      const difference = Number(deadline - now);
      
      if (difference <= 0) {
        // Token expired - record abuse
        const clientIP = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || 
                         (req.headers['x-real-ip'] as string) || 
                         req.socket.remoteAddress || 
                         'unknown';
        const expiredTokenIdentifier = createIdentifier(undefined, `${clientIP}:expired`);
        
        // Record request (will ban after 10 requests in 3 seconds per ABUSE_MAX_REQUESTS config)
        await abuseDetector.recordRequest(expiredTokenIdentifier);
        
        // Return minimal response without logging
        return res.status(410).json({
          error: 'Token deployment period has ended',
          tokenAddress,
        });
      }
    } catch (deadlineError: any) {
      // If deadline check fails, continue to capacity query
      console.error('Deadline check failed:', deadlineError.message);
    }

    const capacityInfo = await tokenCapacityManager.getCapacityStatus(tokenAddress as Address);

    return res.json({
      status: 'ok',
      tokenAddress,
      capacity: {
        max: capacityInfo.maxMintCount,
        current: capacityInfo.currentMintCount,
        pending: capacityInfo.pendingCount,
        available: capacityInfo.availableSlots,
        percentage: Math.round((capacityInfo.currentMintCount / capacityInfo.maxMintCount) * 100),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Capacity query error:', error);
    return res.status(500).json({
      error: 'Failed to query token capacity',
      details: IS_PRODUCTION ? undefined : error.message,
    });
  }
});

/**
 * GET /api/abuse/stats/:identifier
 * Get abuse detection statistics for an address or IP
 */
app.get('/api/abuse/stats/:identifier', async (req: Request, res: Response) => {
  try {
    const { identifier } = req.params;
    
    if (!identifier) {
      return res.status(400).json({
        error: 'Missing identifier',
        message: 'Identifier (address or IP) is required',
      });
    }

    const stats = await abuseDetector.getStats(identifier);

    return res.json({
      status: 'ok',
      identifier,
      stats: {
        requestCount: stats.requestCount,
        isBanned: stats.isBanned,
        banTimeRemaining: stats.banTimeRemaining,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Abuse stats query error:', error);
    return res.status(500).json({
      error: 'Failed to query abuse statistics',
      details: IS_PRODUCTION ? undefined : error.message,
    });
  }
});

/**
 * POST /api/abuse/ban
 * Manually ban an address or IP (admin endpoint)
 */
app.post('/api/abuse/ban', async (req: Request, res: Response) => {
  try {
    const { identifier, durationMs } = req.body;
    
    if (!identifier) {
      return res.status(400).json({
        error: 'Missing identifier',
        message: 'Identifier (address or IP) is required',
      });
    }

    await abuseDetector.manualBan(identifier, durationMs);

    return res.json({
      status: 'ok',
      message: `Successfully banned ${identifier}`,
      identifier,
      durationMs: durationMs || 3600000,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Manual ban error:', error);
    return res.status(500).json({
      error: 'Failed to ban identifier',
      details: IS_PRODUCTION ? undefined : error.message,
    });
  }
});

/**
 * POST /api/abuse/unban
 * Unban an address or IP (admin endpoint)
 */
app.post('/api/abuse/unban', async (req: Request, res: Response) => {
  try {
    const { identifier } = req.body;
    
    if (!identifier) {
      return res.status(400).json({
        error: 'Missing identifier',
        message: 'Identifier (address or IP) is required',
      });
    }

    await abuseDetector.unban(identifier);

    return res.json({
      status: 'ok',
      message: `Successfully unbanned ${identifier}`,
      identifier,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Unban error:', error);
    return res.status(500).json({
      error: 'Failed to unban identifier',
      details: IS_PRODUCTION ? undefined : error.message,
    });
  }
});

/**
 * POST /api/abuse/whitelist/add
 * Add identifier to whitelist (永久豁免限流)
 */
app.post('/api/abuse/whitelist/add', async (req: Request, res: Response) => {
  try {
    const { identifier } = req.body;
    
    if (!identifier) {
      return res.status(400).json({
        error: 'Missing identifier',
        message: 'Identifier (address or IP) is required',
      });
    }

    await abuseDetector.addToWhitelist(identifier);

    return res.json({
      status: 'ok',
      message: `Successfully added ${identifier} to whitelist`,
      identifier,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Whitelist add error:', error);
    return res.status(500).json({
      error: 'Failed to add to whitelist',
      details: IS_PRODUCTION ? undefined : error.message,
    });
  }
});

/**
 * POST /api/abuse/whitelist/remove
 * Remove identifier from whitelist
 */
app.post('/api/abuse/whitelist/remove', async (req: Request, res: Response) => {
  try {
    const { identifier } = req.body;
    
    if (!identifier) {
      return res.status(400).json({
        error: 'Missing identifier',
        message: 'Identifier (address or IP) is required',
      });
    }

    await abuseDetector.removeFromWhitelist(identifier);

    return res.json({
      status: 'ok',
      message: `Successfully removed ${identifier} from whitelist`,
      identifier,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Whitelist remove error:', error);
    return res.status(500).json({
      error: 'Failed to remove from whitelist',
      details: IS_PRODUCTION ? undefined : error.message,
    });
  }
});

/**
 * GET /api/successful-mints
 * Get successful mint tasks from PostgreSQL
 */
// });

// app.get('/api/successful-mints', async (req: Request, res: Response) => {

/**
 * GET /api/successful-mints/:requestId
 * Get specific successful mint task by request ID
 */
// });

/**
 * GET /api/successful-mints/stats
 * Get successful mints statistics
 */
// });

// app.get('/api/successful-mints/stats', async (req: Request, res: Response) => {

/**
 * GET /api/successful-mints/recent
 * Get recent successful mints
 */
// });

// app.get('/api/successful-mints/recent', async (req: Request, res: Response) => {

/**
 * GET /api/mint-status/:requestId
 * Get mint status by request ID (checks both successful and failed mints)
 */
// });

/**
 * GET /api/verify/:address
 * Check if a contract is verified on Basescan
 */
app.get('/api/verify/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      res.status(400).json({ error: 'Invalid address format' });
      return;
    }

    const basescanApiUrl = process.env.BASESCAN_API_URL || 'https://api-sepolia.basescan.org/api';
    const apiKey = process.env.BASESCAN_API_KEY;

    if (!apiKey) {
      res.status(503).json({
        error: 'Basescan API not configured',
        message: 'BASESCAN_API_KEY not set',
      });
      return;
    }

    // Query Basescan to check if contract source code is verified
    const url = `${basescanApiUrl}?module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;

    const response = await fetch(url);
    const data = (await response.json()) as any;

    if (data.status !== '1') {
      res.status(500).json({
        error: 'Failed to check verification status',
        message: data.message || 'Unknown error',
      });
      return;
    }

    const sourceCode = data.result[0];
    const isVerified = sourceCode.SourceCode !== '';
    const isProxy = sourceCode.Proxy !== '0';
    const implementation = sourceCode.Implementation || null;

    return res.json({
      address,
      isVerified,
      isProxy,
      implementation,
      contractName: sourceCode.ContractName || null,
      compilerVersion: sourceCode.CompilerVersion || null,
      optimizationUsed: sourceCode.OptimizationUsed === '1',
      runs: sourceCode.Runs || null,
      constructorArguments: sourceCode.ConstructorArguments || null,
      evmVersion: sourceCode.EVMVersion || null,
      library: sourceCode.Library || null,
      licenseType: sourceCode.LicenseType || null,
      swarmSource: sourceCode.SwarmSource || null,
    });
  } catch (error: any) {
    console.error('Verification check error:', error);
    return res.status(500).json({
      error: 'Failed to check verification status',
      details: IS_PRODUCTION ? undefined : error.message,
    });
  }
});

// ==================== Error Handling ====================

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: any) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: IS_PRODUCTION ? undefined : err.message,
  });
});

// ==================== Start Server ====================

// Initialize PostgreSQL and run migrations before starting server
async function startServer() {
  try {
    // Initialize PostgreSQL if DATABASE_URL is configured

    const server = app.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════════════════════╗
║  x402 Token Launchpad Backend                             ║
╠═══════════════════════════════════════════════════════════╣
║  Status: Running                                          ║
║  Mode: x402 Payment (BSC Mainnet → BSC Testnet)          ║
║  Port: ${PORT.toString().padEnd(50)}║
║  Payment Chain: ${PAYMENT_CHAIN.name.padEnd(41)}║
║  Mint Chain: ${MINT_CHAIN.name.padEnd(44)}║
║  Backend: ${account.address.padEnd(43)}║
║  Payment Token: ${PAYMENT_TOKEN_NAME.padEnd(39)}║
║  Token Address: ${PAYMENT_TOKEN_ADDRESS.padEnd(39)}║
║  Mint Price: 0.1 WUSDT                                    ║
║  Facilitator: ${FACILITATOR_API_URL.padEnd(43)}║
║  Environment: ${(IS_PRODUCTION ? 'Production' : 'Development').padEnd(45)}║
╚═══════════════════════════════════════════════════════════╝
  `);

  console.log('\n📝 Available endpoints:');
  console.log(`  GET  /health                           - Health check`);
  console.log(`  POST /api/mint                         - x402 payment-gated mint endpoint (batched)`);
  console.log(`  GET  /api/payment/health               - Check x402 facilitator connectivity`);
  console.log(`  GET  /api/redis/health                 - Check Redis connection status`);
  console.log(`  GET  /api/verify/:address              - Check contract verification status`);
  console.log('\n🎯 x402 Payment Flow with Batching:');
  console.log(`  1. POST /api/mint (no X-PAYMENT header) → 402 with X-PAYMENT-OPTIONS`);
  console.log(`  2. Client signs EIP-3009 authorization (${PAYMENT_TOKEN_NAME})`);
  console.log(`  3. POST /api/mint (with X-PAYMENT) → Facilitator verify & settle\n`);
    });

    // Graceful shutdown handling
    const gracefulShutdown = async (signal: string) => {
  console.log(`\n⚠️  ${signal} signal received: closing HTTP server and all connections`);

  // Flush batch settle queue
  try {
    await shutdownBatchSettleManager();
    console.log('✅ Batch settle manager shut down');
  } catch (error: any) {
    console.error('❌ Error shutting down batch settle manager:', error.message);
  }

  // Import RedisConnectionManager for shutdown
  const { RedisConnectionManager } = await import('./utils/redisConnectionPool.js');

  // Close Redis connection gracefully
  try {
    await RedisConnectionManager.disconnect();
    console.log('✅ Redis connections closed');
  } catch (error: any) {
    console.error('❌ Error closing Redis connections:', error.message);
  }

  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('❌ Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

    // Listen for termination signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();

export default app;
