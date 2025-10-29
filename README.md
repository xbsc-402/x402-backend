# x402 Launchpad Backend

**HTTP 402 Payment Required** - Complete EIP-3009 Payment Flow

## 🎯 Design Philosophy

- **Full x402 Protocol Usage**: All operations go through HTTP 402 payment flow
- **Backend as Facilitator**: Receives EIP-3009 authorizations and submits to chain
- **Gasless User Experience**: Users only need to sign, gas paid by backend
- **Minimal Dependencies**: Only express + viem + dotenv (~500 lines of code)

## 📋 Core Features

### API Endpoints

| Endpoint | Method | Function | Payment Required |
|------|------|------|---------|
| `/health` | GET | Health check | ❌ |
| `/api/mint` | POST | Request mint (returns 402) or execute mint | ✅ 0.1 USDC |
| `/api/payment/submit` | POST | Submit EIP-3009 authorization (Facilitator) | ❌ |
| `/api/payment/status/:id` | GET | Query payment status | ❌ |
| `/api/verify/:address` | GET | Check contract verification status | ❌ |

## 🚀 Quick Start

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` file:

```env
PORT=3001
NODE_ENV=development

# Base Sepolia testnet
RPC_URL=https://sepolia.base.org
CHAIN_ID=84532

# Backend wallet private key (holds MINTER_ROLE, pays gas)
MINTER_PRIVATE_KEY=0x...

# Basescan API (for contract verification queries)
BASESCAN_API_KEY=your_api_key
BASESCAN_API_URL=https://api-sepolia.basescan.org/api

# CORS
ALLOWED_ORIGINS=http://localhost:3000
```

### 3. Run Development Server

```bash
pnpm dev
```

Server will start at `http://localhost:3001`.

### 4. Testing

```bash
# Health check
curl http://localhost:3001/health

# Response:
# {
#   "status": "ok",
#   "backend": "0x...",
#   "chain": "Base Sepolia",
#   "usdc": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
#   "mintPrice": "0.1 USDC",
#   "mode": "x402 Payment Required"
# }
```

## 🔄 x402 Payment Flow

### Complete Interaction Flow

```
┌──────────────────────────────────────────────────────────────┐
│              x402 Payment Flow (Fully Implemented)                     │
└──────────────────────────────────────────────────────────────┘

1️⃣ User requests mint (without payment)
   POST /api/mint
   {
     "tokenAddress": "0x...",
     "recipients": ["0x...", "0x...", "0x..."]
   }

   ↓

2️⃣ Backend returns 402 Payment Required
   HTTP/1.1 402 Payment Required
   {
     "error": "Payment required",
     "payment": {
       "id": "abc123...",
       "amount": "100000",              // 0.1 USDC (6 decimals)
       "amountFormatted": "0.1 USDC",
       "payee": "0x...",                // Backend wallet address
       "token": "0x036CbD...",          // USDC contract address
       "nonce": "0x...",                // Random nonce
       "validBefore": "1735689600",     // Expiration time (10 minutes)
       "chainId": 84532,
       "instructions": {
         "step1": "Sign the transfer authorization using EIP-3009",
         "step2": "Submit the signed authorization to POST /api/payment/submit",
         "step3": "Retry this request with the payment transaction hash"
       }
     }
   }

3️⃣ User signs EIP-3009 authorization (off-chain, 0 Gas)
   Domain: {
     name: 'USD Coin',  // or 'USDC', depends on token
     version: '2',
     chainId: 84532,
     verifyingContract: '0x036CbD...'  // USDC address
   }

   Types: {
     TransferWithAuthorization: [
       { name: 'from', type: 'address' },
       { name: 'to', type: 'address' },
       { name: 'value', type: 'uint256' },
       { name: 'validAfter', type: 'uint256' },
       { name: 'validBefore', type: 'uint256' },
       { name: 'nonce', type: 'bytes32' }
     ]
   }

   Message: {
     from: '0x...',        // User address
     to: '0x...',          // Backend address (from payment.payee)
     value: 100000,        // 0.1 USDC
     validAfter: 0,
     validBefore: 1735689600,
     nonce: '0x...'        // From payment.nonce
   }

4️⃣ Submit authorization to backend (backend as Facilitator)
   POST /api/payment/submit
   {
     "authorization": {
       "from": "0x...",
       "to": "0x...",
       "value": "100000",
       "validAfter": "0",
       "validBefore": "1735689600",
       "nonce": "0x..."
     },
     "signature": "0x..."
   }

   ↓

5️⃣ Backend verifies and submits to chain
   - Verify authorization matches payment request
   - Verify time window
   - Verify EIP-3009 signature
   - Check nonce is unused
   - Call USDC.transferWithAuthorization()
   - Wait for transaction confirmation

   ↓

6️⃣ Backend returns payment confirmation
   {
     "success": true,
     "txHash": "0x...",
     "message": "Payment confirmed on-chain",
     "next": "Use this txHash as paymentHash in POST /api/mint"
   }

7️⃣ User re-requests mint with payment proof
   POST /api/mint
   {
     "paymentHash": "0x...",           // From step 6
     "tokenAddress": "0x...",
     "recipients": ["0x...", "0x...", "0x..."]
   }

   ↓

8️⃣ Backend verifies payment and executes mint
   - Query payment record
   - Verify payment is completed
   - Verify metadata matches (tokenAddress + recipients)
   - Call token.batchMint()
   - Return mint transaction hash

   {
     "success": true,
     "txHash": "0x...",
     "recipients": 3,
     "paymentHash": "0x...",
     "message": "Mint transaction submitted successfully"
   }
```

---

## 📡 Detailed API Documentation

### GET /health

Health check endpoint.

**Response**:

```json
{
  "status": "ok",
  "timestamp": "2025-01-24T10:00:00.000Z",
  "backend": "0x...",
  "chain": "Base Sepolia",
  "chainId": 84532,
  "usdc": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "mintPrice": "0.1 USDC",
  "mode": "x402 Payment Required"
}
```

---

### POST /api/mint

Request mint (returns 402) or execute mint (with payment proof).

#### Scenario 1: Request Mint (No Payment)

**Request Body**:

```json
{
  "tokenAddress": "0x...",
  "recipients": ["0x123...", "0x456...", "0x789..."]
}
```

**Response** (402 Payment Required):

```json
{
  "error": "Payment required",
  "payment": {
    "id": "abc123...",
    "amount": "100000",
    "decimals": 6,
    "amountFormatted": "0.1 USDC",
    "payee": "0x...",
    "token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "tokenSymbol": "USDC",
    "nonce": "0x...",
    "validBefore": "1735689600",
    "validitySeconds": 600,
    "chainId": 84532,
    "instructions": {
      "step1": "Sign the transfer authorization using EIP-3009",
      "step2": "Submit the signed authorization to POST /api/payment/submit",
      "step3": "Retry this request with the payment transaction hash"
    }
  }
}
```

#### Scenario 2: Execute Mint (With Payment Proof)

**Request Body**:

```json
{
  "paymentHash": "0x...",
  "tokenAddress": "0x...",
  "recipients": ["0x123...", "0x456...", "0x789..."]
}
```

**Response** (200 OK):

```json
{
  "success": true,
  "txHash": "0x...",
  "recipients": 3,
  "paymentHash": "0x...",
  "message": "Mint transaction submitted successfully"
}
```

**Error Responses**:

```json
// 403 - Invalid or incomplete payment
{
  "error": "Invalid or unfulfilled payment",
  "message": "Please complete the payment first via POST /api/payment/submit"
}

// 403 - Payment mismatch
{
  "error": "Payment does not match mint request",
  "message": "Token address or recipients do not match the paid request"
}

// 400 - Exceeds mint limit
{
  "error": "Mint count would exceed maximum",
  "current": 100,
  "max": 1000,
  "requested": 5
}
```

---

### POST /api/payment/submit

Submit EIP-3009 transfer authorization (backend as Facilitator).

**Request Body**:

```json
{
  "authorization": {
    "from": "0x...",
    "to": "0x...",
    "value": "100000",
    "validAfter": "0",
    "validBefore": "1735689600",
    "nonce": "0x..."
  },
  "signature": "0x..."
}
```

**Response** (200 OK):

```json
{
  "success": true,
  "txHash": "0x...",
  "message": "Payment confirmed on-chain",
  "next": "Use this txHash as paymentHash in POST /api/mint"
}
```

**Error Responses**:

```json
// 400 - Authorization verification failed
{
  "error": "Payment authorization failed",
  "message": "Invalid signature"
}

// 400 - Payment request not found
{
  "error": "Payment authorization failed",
  "message": "Payment request not found or already fulfilled"
}

// 400 - Authorization mismatch
{
  "error": "Payment authorization failed",
  "message": "Authorization does not match payment request"
}

// 400 - Nonce already used
{
  "error": "Payment authorization failed",
  "message": "Authorization nonce already used"
}
```

---

### GET /api/payment/status/:id

Query payment request status.

**Response**:

```json
{
  "id": "abc123...",
  "amount": "100000",
  "amountFormatted": "0.1 USDC",
  "payee": "0x...",
  "token": "0x036CbD...",
  "nonce": "0x...",
  "validBefore": "1735689600",
  "fulfilled": true,
  "txHash": "0x...",
  "metadata": {
    "tokenAddress": "0x...",
    "recipients": ["0x...", "0x..."],
    "requestedAt": 1735686000000
  },
  "createdAt": "2025-01-24T10:00:00.000Z"
}
```

---

### GET /api/payment/debug

View all payment requests (development environment only).

**Response**:

```json
{
  "pending": [
    {
      "id": "abc123...",
      "amount": "100000",
      "nonce": "0x...",
      "fulfilled": false,
      "metadata": {...}
    }
  ],
  "fulfilled": [
    {
      "id": "def456...",
      "amount": "100000",
      "nonce": "0x...",
      "txHash": "0x...",
      "fulfilled": true,
      "metadata": {...}
    }
  ]
}
```

---

### GET /api/verify/:address

Check contract verification status on Basescan.

**Response**:

```json
{
  "address": "0x...",
  "isVerified": true,
  "isProxy": true,
  "implementation": "0x...",
  "contractName": "X402Token",
  "compilerVersion": "v0.8.26+commit.8a97fa7a",
  "optimizationUsed": true,
  "runs": 200
}
```

---

## 🔒 Security Mechanisms

### 1. EIP-3009 Signature Verification

```typescript
// Verify USDC transfer authorization signature
const isValid = await verifyTransferWithAuthorization(
  authorization,
  signature,
  USDC_ADDRESS,
  'USD Coin',  // USDC's EIP-712 name
  CHAIN.id
);
```

### 2. Payment Request Matching

```typescript
// Verify payment metadata matches mint request
if (
  paidTokenAddress !== tokenAddress ||
  JSON.stringify(paidRecipients) !== JSON.stringify(recipients)
) {
  return error('Payment does not match mint request');
}
```

### 3. Nonce Anti-Replay

```typescript
// Check on-chain authorization state
const authState = await usdc.authorizationState(from, nonce);
if (authState !== 0) {
  return error('Authorization nonce already used');
}
```

### 4. Time Window Verification

```typescript
// Verify authorization is within validity period
function isAuthorizationValid(validAfter: bigint, validBefore: bigint) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return now >= validAfter && now <= validBefore;
}
```

### 5. Automatic Payment Request Cleanup

```typescript
// Clean up expired payment requests every 5 minutes
setInterval(() => {
  cleanupExpiredRequests();
}, 5 * 60 * 1000);
```

---

## 🏗️ Architecture Design

### File Structure

```
backend/
├── src/
│   ├── server.ts        # Main server (x402 flow)
│   ├── eip3009.ts       # EIP-3009 signature verification
│   ├── payment.ts       # Payment request management (Facilitator)
│   ├── contracts.ts     # Contract ABI (includes EIP-3009)
│   └── signature.ts     # [Removed] Legacy mint signature verification
├── package.json
├── tsconfig.json
└── .env.example
```

### Data Flow

```
┌──────────┐                ┌──────────┐                ┌──────────┐
│  Client  │                │ Backend  │                │  Chain   │
└────┬─────┘                └────┬─────┘                └────┬─────┘
     │                           │                           │
     │  1. POST /api/mint        │                           │
     │ ───────────────────────→  │                           │
     │                           │                           │
     │  2. 402 Payment Required  │                           │
     │ ←───────────────────────  │                           │
     │  (payment details)        │                           │
     │                           │                           │
     │  3. Sign EIP-3009         │                           │
     │  (off-chain)              │                           │
     │                           │                           │
     │  4. POST /payment/submit  │                           │
     │ ───────────────────────→  │                           │
     │                           │  5. Verify & Submit       │
     │                           │ ───────────────────────→  │
     │                           │     transferWith          │
     │                           │     Authorization()       │
     │                           │                           │
     │                           │  6. tx confirmed          │
     │                           │ ←───────────────────────  │
     │                           │                           │
     │  7. {txHash}              │                           │
     │ ←───────────────────────  │                           │
     │                           │                           │
     │  8. POST /api/mint        │                           │
     │  (with paymentHash)       │                           │
     │ ───────────────────────→  │                           │
     │                           │  9. Verify payment        │
     │                           │  10. Call batchMint()     │
     │                           │ ───────────────────────→  │
     │                           │                           │
     │                           │  11. tx confirmed         │
     │                           │ ←───────────────────────  │
     │  12. {mintTxHash}         │                           │
     │ ←───────────────────────  │                           │
     │                           │                           │
```

---

## 🎨 Frontend Integration Example

### TypeScript/React Example

```typescript
import { ethers } from 'ethers';

async function mintTokens(
  tokenAddress: string,
  recipients: string[],
  signer: ethers.Signer
) {
  const backendUrl = 'http://localhost:3001';

  // 1. Request mint → Get 402 response
  const mintResponse = await fetch(`${backendUrl}/api/mint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenAddress, recipients }),
  });

  if (mintResponse.status !== 402) {
    throw new Error('Expected 402 Payment Required');
  }

  const { payment } = await mintResponse.json();
  console.log('💳 Payment required:', payment);

  // 2. Sign EIP-3009 authorization
  const domain = {
    name: 'USD Coin',  // or read from USDC.name()
    version: '2',
    chainId: payment.chainId,
    verifyingContract: payment.token,
  };

  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  const message = {
    from: await signer.getAddress(),
    to: payment.payee,
    value: payment.amount,
    validAfter: 0,
    validBefore: payment.validBefore,
    nonce: payment.nonce,
  };

  const signature = await signer.signTypedData(domain, types, message);

  // 3. Submit authorization to backend (Facilitator)
  const paymentResponse = await fetch(`${backendUrl}/api/payment/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      authorization: message,
      signature,
    }),
  });

  if (!paymentResponse.ok) {
    const error = await paymentResponse.json();
    throw new Error(error.message || 'Payment failed');
  }

  const { txHash: paymentHash } = await paymentResponse.json();
  console.log('✅ Payment confirmed:', paymentHash);

  // 4. Execute mint with payment proof
  const executeMintResponse = await fetch(`${backendUrl}/api/mint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paymentHash,
      tokenAddress,
      recipients,
    }),
  });

  if (!executeMintResponse.ok) {
    const error = await executeMintResponse.json();
    throw new Error(error.message || 'Mint failed');
  }

  const result = await executeMintResponse.json();
  console.log('🪙 Mint successful:', result.txHash);

  return result;
}
```

---

## 🔧 Production Environment Deployment

### Environment Variable Configuration

```env
# Production environment
NODE_ENV=production

# Base Mainnet
RPC_URL=https://mainnet.base.org
CHAIN_ID=8453

# Backend wallet (needs sufficient ETH to pay gas)
MINTER_PRIVATE_KEY=0x...

# Basescan Mainnet
BASESCAN_API_KEY=...
BASESCAN_API_URL=https://api.basescan.org/api

# CORS (frontend domain)
ALLOWED_ORIGINS=https://launchpad.example.com
```

### Using Railway

```bash
railway up
railway variables set MINTER_PRIVATE_KEY=0x...
railway variables set RPC_URL=https://mainnet.base.org
railway deploy
```

### Using Docker

```bash
docker build -t x402-launchpad-backend .
docker run -p 3001:3001 --env-file .env x402-launchpad-backend
```

---

## 📊 Monitoring and Logging

### Request Logs

```
2025-01-24T10:00:00.000Z POST /api/mint
💳 Payment request created: abc123...
   Amount: 0.1 USDC
   Token: 0x...
   Recipients: 3

2025-01-24T10:00:30.000Z POST /api/payment/submit
💳 Processing payment authorization...
   From: 0x...
   To: 0x...
   Amount: 100000
✅ Payment confirmed: 0x...

2025-01-24T10:01:00.000Z POST /api/mint
🔍 Verifying payment: 0x...
✅ Payment verified: 0x...
   Paid: 0.1 USDC
   For token: 0x...
🪙 Minting 3 tokens to 0x...
✅ Mint transaction sent: 0x...
```

---

## ❓ Frequently Asked Questions

### Q: Why use x402 instead of direct ETH payment?

A:
- ✅ **Gasless Experience**: Users only need to sign, no need to hold ETH
- ✅ **Stablecoin Payment**: Uses USDC, stable price
- ✅ **HTTP Standard**: Complies with HTTP 402 Payment Required specification
- ✅ **Decentralized**: EIP-3009 authorization executed on-chain, no need to trust backend

### Q: How does the backend make money?

A: Backend charges 0.1 USDC minting fee, which can cover gas costs and generate profit.

### Q: What if user signs but doesn't submit?

A: Authorization has 10-minute validity period, automatically expires after timeout. Backend periodically cleans up expired payment requests.

### Q: Can other tokens be used for payment?

A: Yes! Just modify `USDC_ADDRESS` to other EIP-3009 compatible tokens (like USDT, DAI, etc.).

### Q: How to store payment requests in production environment?

A: Currently uses in-memory storage. Production environment should use Redis:

```typescript
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

// Store payment request (10 minutes TTL)
await redis.setex(
  `payment:${id}`,
  600,
  JSON.stringify(paymentRequest)
);

// Read payment request
const data = await redis.get(`payment:${id}`);
const payment = JSON.parse(data);
```

---

## 📄 License

MIT

---

## 🔗 Related Resources

- [EIP-3009 Specification](https://eips.ethereum.org/EIPS/eip-3009)
- [x402 Protocol Documentation](https://docs.x402.org)
- [USDC Documentation](https://developers.circle.com/stablecoins/docs)
- [Base Documentation](https://docs.base.org)
- [Contract Verification Guide](../contracts/CONTRACT_VERIFICATION.md)
