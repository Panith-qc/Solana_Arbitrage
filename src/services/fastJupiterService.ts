// FAST JUPITER V6 SERVICE - DIRECT API (NO SUPABASE WRAPPER)
// ⚡ Speed optimized for MEV trading (milliseconds matter!)
// Direct connection to Jupiter API - bypasses slow Supabase edge function

import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';

export interface FastQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  priceImpactPct: number;
  routePlan: any[];
  timeTakenMs: number; // Track API latency
}

export interface FastSwapResult {
  success: boolean;
  signature?: string;
  timeTakenMs: number;
  error?: string;
}

export class FastJupiterService {
  // DIRECT Jupiter V6 API (no slow wrappers!)
  private readonly JUPITER_V6_API = 'https://quote-api.jup.ag/v6';
  
  // AGGRESSIVE TIMEOUTS for speed
  private readonly QUOTE_TIMEOUT_MS = 1000; // 1 second max
  private readonly SWAP_TIMEOUT_MS = 2000; // 2 seconds max
  
  private connection: Connection;
  
  // Performance metrics
  private metrics = {
    totalQuotes: 0,
    successfulQuotes: 0,
    failedQuotes: 0,
    avgQuoteTimeMs: 0,
    fastestQuoteMs: Infinity,
    slowestQuoteMs: 0,
  };

  constructor(connection: Connection) {
    this.connection = connection;
    console.log('⚡ Fast Jupiter Service initialized (DIRECT V6 API)');
    console.log(`⏱️  Quote timeout: ${this.QUOTE_TIMEOUT_MS}ms`);
    console.log(`⏱️  Swap timeout: ${this.SWAP_TIMEOUT_MS}ms`);
  }

  /**
   * Get quote with aggressive timeout (FAST!)
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50
  ): Promise<FastQuote | null> {
    const startTime = Date.now();
    this.metrics.totalQuotes++;

    try {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.QUOTE_TIMEOUT_MS);

      const url = `${this.JUPITER_V6_API}/quote?` + new URLSearchParams({
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: slippageBps.toString(),
        onlyDirectRoutes: 'false',
        asLegacyTransaction: 'false',
      });

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Jupiter API error: ${response.status}`);
      }

      const data = await response.json();
      const timeTakenMs = Date.now() - startTime;

      // Update metrics
      this.metrics.successfulQuotes++;
      this.metrics.avgQuoteTimeMs = 
        (this.metrics.avgQuoteTimeMs * (this.metrics.successfulQuotes - 1) + timeTakenMs) / 
        this.metrics.successfulQuotes;
      this.metrics.fastestQuoteMs = Math.min(this.metrics.fastestQuoteMs, timeTakenMs);
      this.metrics.slowestQuoteMs = Math.max(this.metrics.slowestQuoteMs, timeTakenMs);

      return {
        inputMint: data.inputMint,
        inAmount: data.inAmount,
        outputMint: data.outputMint,
        outAmount: data.outAmount,
        priceImpactPct: parseFloat(data.priceImpactPct || '0'),
        routePlan: data.routePlan || [],
        timeTakenMs,
      };

    } catch (error: any) {
      this.metrics.failedQuotes++;
      const timeTakenMs = Date.now() - startTime;

      // Don't log timeouts (expected in MEV)
      if (error.name !== 'AbortError') {
        console.error(`❌ Quote error (${timeTakenMs}ms):`, error.message);
      }

      return null;
    }
  }

  /**
   * Get multiple quotes in parallel (FAST!)
   */
  async getQuotesBatch(
    requests: Array<{
      inputMint: string;
      outputMint: string;
      amount: number;
      slippageBps?: number;
    }>
  ): Promise<Array<FastQuote | null>> {
    console.log(`⚡ Getting ${requests.length} quotes in parallel...`);
    const startTime = Date.now();

    // Execute all quotes in parallel
    const quotes = await Promise.all(
      requests.map(req => 
        this.getQuote(req.inputMint, req.outputMint, req.amount, req.slippageBps)
      )
    );

    const totalTime = Date.now() - startTime;
    const successCount = quotes.filter(q => q !== null).length;

    console.log(`✅ Batch complete: ${successCount}/${requests.length} quotes in ${totalTime}ms`);
    console.log(`⏱️  Avg per quote: ${Math.round(totalTime / requests.length)}ms`);

    return quotes;
  }

  /**
   * Get swap transaction with timeout
   */
  async getSwapTransaction(
    quote: FastQuote,
    userPublicKey: string,
    priorityFeeLamports: number = 5000
  ): Promise<string | null> {
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.SWAP_TIMEOUT_MS);

      const response = await fetch(`${this.JUPITER_V6_API}/swap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey,
          wrapAndUnwrapSol: true,
          computeUnitPriceMicroLamports: priorityFeeLamports,
          asLegacyTransaction: false,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Swap API error: ${response.status}`);
      }

      const data = await response.json();
      const timeTakenMs = Date.now() - startTime;

      console.log(`✅ Swap TX prepared in ${timeTakenMs}ms`);
      return data.swapTransaction;

    } catch (error: any) {
      const timeTakenMs = Date.now() - startTime;
      console.error(`❌ Swap TX error (${timeTakenMs}ms):`, error.message);
      return null;
    }
  }

  /**
   * Execute swap with millisecond timing
   */
  async executeSwap(
    quote: FastQuote,
    userPublicKey: PublicKey,
    signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
    priorityFeeLamports: number = 5000
  ): Promise<FastSwapResult> {
    const startTime = Date.now();

    try {
      // Get swap transaction
      const swapTxBase64 = await this.getSwapTransaction(
        quote,
        userPublicKey.toString(),
        priorityFeeLamports
      );

      if (!swapTxBase64) {
        throw new Error('Failed to get swap transaction');
      }

      // Deserialize and sign
      const swapTxBuffer = Buffer.from(swapTxBase64, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTxBuffer);
      const signedTx = await signTransaction(transaction);

      // Send transaction
      const signature = await this.connection.sendRawTransaction(
        signedTx.serialize(),
        {
          skipPreflight: true, // SPEED: Skip preflight for MEV
          maxRetries: 0, // SPEED: No retries
        }
      );

      const timeTakenMs = Date.now() - startTime;

      console.log(`✅ Swap executed in ${timeTakenMs}ms`);
      console.log(`📝 Signature: ${signature}`);

      return {
        success: true,
        signature,
        timeTakenMs,
      };

    } catch (error: any) {
      const timeTakenMs = Date.now() - startTime;
      return {
        success: false,
        timeTakenMs,
        error: error.message,
      };
    }
  }

  /**
   * Get performance metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      successRate: this.metrics.totalQuotes > 0
        ? (this.metrics.successfulQuotes / this.metrics.totalQuotes * 100).toFixed(2) + '%'
        : '0%',
    };
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      totalQuotes: 0,
      successfulQuotes: 0,
      failedQuotes: 0,
      avgQuoteTimeMs: 0,
      fastestQuoteMs: Infinity,
      slowestQuoteMs: 0,
    };
    console.log('📊 Metrics reset');
  }

  /**
   * Health check with timing
   */
  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    
    const startTime = Date.now();
    const quote = await this.getQuote(SOL, USDC, 1000000); // 0.001 SOL
    const latencyMs = Date.now() - startTime;

    return {
      healthy: quote !== null,
      latencyMs,
    };
  }
}

// Export singleton
let fastJupiterService: FastJupiterService | null = null;

export function initFastJupiterService(connection: Connection): FastJupiterService {
  if (!fastJupiterService) {
    fastJupiterService = new FastJupiterService(connection);
  }
  return fastJupiterService;
}

export function getFastJupiterService(): FastJupiterService {
  if (!fastJupiterService) {
    throw new Error('FastJupiterService not initialized. Call initFastJupiterService first.');
  }
  return fastJupiterService;
}
