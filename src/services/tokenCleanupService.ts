import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { privateKeyWallet } from './privateKeyWallet';
import { supabaseJupiterService } from './supabaseJupiterService';

export interface TokenBalance {
  mint: string;
  symbol: string;
  balance: number;
  decimals: number;
  uiAmount: number;
  valueUsd: number;
}

export interface CleanupResult {
  success: boolean;
  tokensCleaned: number;
  totalValueRecovered: number;
  transactions: string[];
  errors: string[];
}

export class TokenCleanupService {
  private connection: Connection;
  private solMint = 'So11111111111111111111111111111111111111112';

  constructor() {
    this.connection = privateKeyWallet.getConnection();
    console.log('🧹 Token Cleanup Service initialized - Convert all tokens back to SOL');
  }

  async scanWalletTokens(): Promise<TokenBalance[]> {
    console.log('🔍 Scanning wallet for stuck tokens...');
    
    try {
      const keypair = privateKeyWallet.getKeypair();
      if (!keypair) {
        throw new Error('Wallet not connected');
      }

      const walletAddress = keypair.publicKey.toString();
      console.log(`📊 Scanning wallet: ${walletAddress.slice(0, 8)}...`);

      // Get all token accounts for the wallet
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        keypair.publicKey,
        { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
      );

      const tokens: TokenBalance[] = [];
      
      for (const account of tokenAccounts.value) {
        const accountData = account.account.data.parsed.info;
        const mint = accountData.mint;
        const balance = parseInt(accountData.tokenAmount.amount);
        const decimals = accountData.tokenAmount.decimals;
        const uiAmount = accountData.tokenAmount.uiAmount;

        // Skip if balance is 0 or if it's already SOL
        if (balance === 0 || mint === this.solMint) {
          continue;
        }

        // Get token symbol and estimate value
        const symbol = await this.getTokenSymbol(mint);
        const valueUsd = await this.estimateTokenValue(mint, balance, decimals);

        tokens.push({
          mint,
          symbol,
          balance,
          decimals,
          uiAmount,
          valueUsd
        });

        console.log(`💰 Found ${symbol}: ${uiAmount} tokens (~$${(valueUsd != null && !isNaN(valueUsd) && typeof valueUsd === 'number' ? valueUsd.toFixed(4) : '0.0000')})`);
      }

      console.log(`📊 Total stuck tokens found: ${tokens.length}`);
      return tokens.sort((a, b) => b.valueUsd - a.valueUsd); // Sort by value descending

    } catch (error) {
      console.error('❌ Failed to scan wallet tokens:', error);
      return [];
    }
  }

  async cleanupAllTokens(minValueUsd: number = 0.001): Promise<CleanupResult> {
    console.log(`🧹 Starting token cleanup (minimum value: $${minValueUsd})...`);
    
    const result: CleanupResult = {
      success: false,
      tokensCleaned: 0,
      totalValueRecovered: 0,
      transactions: [],
      errors: []
    };

    try {
      const tokens = await this.scanWalletTokens();
      const tokensToClean = tokens.filter(token => token.valueUsd >= minValueUsd);

      console.log(`🎯 Cleaning ${tokensToClean.length} tokens (${tokens.length - tokensToClean.length} below threshold)`);

      for (const token of tokensToClean) {
        try {
          console.log(`🔄 Converting ${token.symbol} to SOL...`);
          const txHash = await this.convertTokenToSol(token);
          
          if (txHash) {
            result.transactions.push(txHash);
            result.tokensCleaned++;
            result.totalValueRecovered += token.valueUsd;
            console.log(`✅ ${token.symbol} → SOL: https://solscan.io/tx/${txHash}`);
          }

          // Small delay between conversions
          await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
          const errorMsg = `Failed to convert ${token.symbol}: ${error instanceof Error ? error.message : 'Unknown error'}`;
          result.errors.push(errorMsg);
          console.error(`❌ ${errorMsg}`);
        }
      }

      result.success = result.tokensCleaned > 0;
      
      console.log(`🧹 CLEANUP COMPLETE:`);
      console.log(`✅ Tokens cleaned: ${result.tokensCleaned}`);
      console.log(`💰 Value recovered: ~$${(result.totalValueRecovered != null && !isNaN(result.totalValueRecovered) && typeof result.totalValueRecovered === 'number' ? result.totalValueRecovered.toFixed(4) : '0.0000')}`);
      console.log(`❌ Errors: ${result.errors.length}`);

      return result;

    } catch (error) {
      console.error('❌ Token cleanup failed:', error);
      result.errors.push(error instanceof Error ? error.message : 'Unknown error');
      return result;
    }
  }

  private async convertTokenToSol(token: TokenBalance): Promise<string | null> {
    try {
      const keypair = privateKeyWallet.getKeypair();
      if (!keypair) {
        throw new Error('Wallet not connected');
      }

      // Get quote for Token → SOL conversion
      const quote = await supabaseJupiterService.getQuote(
        token.mint,
        this.solMint,
        token.balance,
        300 // 3% slippage for stuck token cleanup
      );

      if (!quote) {
        throw new Error('No quote available for conversion');
      }

      console.log(`📊 ${token.symbol} Quote: ${token.uiAmount} → ${((parseInt(quote.outAmount) / 1e9) != null && !isNaN(parseInt(quote.outAmount) / 1e9) && typeof (parseInt(quote.outAmount) / 1e9) === 'number' ? (parseInt(quote.outAmount) / 1e9).toFixed(6) : '0.000000')} SOL`);

      // Get swap transaction with high priority
      const swapTransaction = await supabaseJupiterService.getSwapTransaction(
        quote,
        keypair.publicKey.toString(),
        15000000 // 0.015 SOL priority fee for cleanup
      );

      if (!swapTransaction) {
        throw new Error('Failed to get swap transaction');
      }

      // Execute the swap - Fix the VersionedTransaction import issue
      const txBuf = Buffer.from(swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(txBuf);
      transaction.sign([keypair]);

      const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false, // Enable preflight for cleanup
        preflightCommitment: 'processed',
        maxRetries: 3 // More retries for cleanup
      });

      return signature;

    } catch (error) {
      console.error(`❌ Failed to convert ${token.symbol}:`, error);
      return null;
    }
  }

  private async getTokenSymbol(mint: string): Promise<string> {
    // Common token symbols mapping
    const knownTokens: { [key: string]: string } = {
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
      'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'WIF',
      '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr': 'POPCAT',
      'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP'
    };

    return knownTokens[mint] || mint.slice(0, 8) + '...';
  }

  private async estimateTokenValue(mint: string, balance: number, decimals: number): Promise<number> {
    try {
      // Try to get a quote to SOL to estimate value
      const quote = await supabaseJupiterService.getQuote(
        mint,
        this.solMint,
        balance,
        500 // 5% slippage for estimation
      );

      if (quote) {
        const solAmount = parseInt(quote.outAmount) / 1e9;
        return solAmount * 240; // Estimate USD value
      }

      return 0;
    } catch (error) {
      // If quote fails, assume minimal value
      return 0.001;
    }
  }
}

export const tokenCleanupService = new TokenCleanupService();