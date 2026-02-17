// TOKEN SAFETY FILTER
// Analyzes newly detected tokens for safety before sniping.
// Returns a SafetyResult with pass/fail and detailed scoring.

import { Connection, PublicKey } from '@solana/web3.js';
import { strategyLog } from '../logger.js';
import { BotConfig, LAMPORTS_PER_SOL } from '../config.js';
import { ConnectionManager } from '../connectionManager.js';

export interface SafetyResult {
  passed: boolean;
  score: number;              // 0-100
  rejectReason: string | null;
  details: {
    mintAuthorityRevoked: boolean;
    freezeAuthorityRevoked: boolean;
    top10HolderPercent: number;
    initialLiquiditySol: number;
    poolAgeSeconds: number;
    liquidityScore: number;     // 0-25
    holderScore: number;        // 0-25
    lockScore: number;          // 0-25
    metadataScore: number;      // 0-25
    totalSupply: number;
    holderCount: number;
  };
  tokenMint: string;
  checkedAt: number;
}

export interface TokenCheckInput {
  tokenMint: string;
  poolAddress: string;
  initialLiquidityLamports: number;
  poolCreatedAt: number;       // unix ms
  lpMint: string | null;
}

// Metaplex Token Metadata program
const TOKEN_METADATA_PROGRAM = new PublicKey('metaqbxxUoYSflSKQASbR64Q5ELBGKBTVma3KmGkfLP');

export class TokenSafetyFilter {
  private connectionManager: ConnectionManager;
  private config: BotConfig;

  constructor(connectionManager: ConnectionManager, config: BotConfig) {
    this.connectionManager = connectionManager;
    this.config = config;
  }

  async check(input: TokenCheckInput): Promise<SafetyResult> {
    const startMs = Date.now();
    const conn = this.connectionManager.getConnection();
    const mint = new PublicKey(input.tokenMint);

    const result: SafetyResult = {
      passed: false,
      score: 0,
      rejectReason: null,
      details: {
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        top10HolderPercent: 100,
        initialLiquiditySol: input.initialLiquidityLamports / LAMPORTS_PER_SOL,
        poolAgeSeconds: (Date.now() - input.poolCreatedAt) / 1000,
        liquidityScore: 0,
        holderScore: 0,
        lockScore: 0,
        metadataScore: 0,
        totalSupply: 0,
        holderCount: 0,
      },
      tokenMint: input.tokenMint,
      checkedAt: Date.now(),
    };

    try {
      // ── HARD REJECT CHECKS ─────────────────────────────────────

      // 1. Check mint + freeze authority (1 RPC call)
      const mintInfo = await conn.getParsedAccountInfo(mint);
      if (!mintInfo.value) {
        result.rejectReason = 'Mint account not found';
        return result;
      }

      const mintData = (mintInfo.value.data as any)?.parsed?.info;
      if (!mintData) {
        result.rejectReason = 'Cannot parse mint data';
        return result;
      }

      result.details.mintAuthorityRevoked = mintData.mintAuthority === null;
      result.details.freezeAuthorityRevoked = mintData.freezeAuthority === null;
      result.details.totalSupply = parseInt(mintData.supply || '0');

      if (!result.details.mintAuthorityRevoked) {
        result.rejectReason = 'Mint authority not revoked';
        return result;
      }

      if (!result.details.freezeAuthorityRevoked) {
        result.rejectReason = 'Freeze authority not revoked';
        return result;
      }

      // 2. Check initial liquidity (from input, no RPC needed)
      if (result.details.initialLiquiditySol < 2.0) {
        result.rejectReason = `Initial liquidity too low: ${result.details.initialLiquiditySol.toFixed(2)} SOL (min 2.0)`;
        return result;
      }

      // 3. Check pool age
      if (result.details.poolAgeSeconds < 60) {
        result.rejectReason = `Pool too new: ${result.details.poolAgeSeconds.toFixed(0)}s (min 60s)`;
        return result;
      }

      // 4. Check holder distribution (1 RPC call - getTokenLargestAccounts)
      const largestAccounts = await conn.getTokenLargestAccounts(mint);
      const topHolders = largestAccounts.value.slice(0, 10);
      result.details.holderCount = largestAccounts.value.length;

      if (result.details.totalSupply > 0 && topHolders.length > 0) {
        const top10Amount = topHolders.reduce(
          (sum, h) => sum + parseInt(h.amount), 0,
        );
        result.details.top10HolderPercent = (top10Amount / result.details.totalSupply) * 100;
      }

      if (result.details.top10HolderPercent > 30) {
        result.rejectReason = `Top 10 wallets hold ${result.details.top10HolderPercent.toFixed(1)}% (max 30%)`;
        return result;
      }

      // ── SCORING ────────────────────────────────────────────────

      // Liquidity score (0-25)
      const liqSol = result.details.initialLiquiditySol;
      if (liqSol >= 50) result.details.liquidityScore = 25;
      else if (liqSol >= 20) result.details.liquidityScore = 20;
      else if (liqSol >= 10) result.details.liquidityScore = 15;
      else if (liqSol >= 5) result.details.liquidityScore = 10;
      else result.details.liquidityScore = 5;

      // Holder distribution score (0-25)
      // Lower concentration = better
      const top10Pct = result.details.top10HolderPercent;
      if (top10Pct <= 5) result.details.holderScore = 25;
      else if (top10Pct <= 10) result.details.holderScore = 20;
      else if (top10Pct <= 15) result.details.holderScore = 15;
      else if (top10Pct <= 20) result.details.holderScore = 10;
      else if (top10Pct <= 25) result.details.holderScore = 5;
      else result.details.holderScore = 2;

      // Lock score (0-25) - check if LP tokens are burned or locked
      // (1 RPC call if lpMint provided)
      if (input.lpMint) {
        try {
          const lpMintInfo = await conn.getParsedAccountInfo(new PublicKey(input.lpMint));
          const lpData = (lpMintInfo.value?.data as any)?.parsed?.info;
          if (lpData) {
            const lpSupply = parseInt(lpData.supply || '0');
            // Check if LP mint authority is revoked (burned)
            if (lpData.mintAuthority === null && lpSupply > 0) {
              result.details.lockScore = 25; // LP burned = maximum trust
            } else {
              result.details.lockScore = 10; // LP exists but not burned
            }
          }
        } catch {
          result.details.lockScore = 5; // Couldn't check
        }
      } else {
        result.details.lockScore = 5; // No LP mint info
      }

      // Metadata score (0-25) - check Metaplex metadata
      // (1 RPC call)
      try {
        const [metadataPda] = PublicKey.findProgramAddressSync(
          [
            Buffer.from('metadata'),
            TOKEN_METADATA_PROGRAM.toBuffer(),
            mint.toBuffer(),
          ],
          TOKEN_METADATA_PROGRAM,
        );

        const metadataAccount = await conn.getAccountInfo(metadataPda);
        if (metadataAccount && metadataAccount.data.length > 0) {
          // Parse basic metadata fields from the raw data
          // Metaplex metadata has: name, symbol, uri at known offsets
          const data = metadataAccount.data;
          let metaPoints = 0;

          // Check if data has reasonable length (name starts at offset ~65)
          if (data.length > 100) {
            // Name present (at offset ~65, length-prefixed)
            const nameLen = data.readUInt32LE(65);
            if (nameLen > 0 && nameLen < 100) metaPoints += 7;

            // Symbol present
            const symbolOffset = 65 + 4 + nameLen;
            if (symbolOffset + 4 < data.length) {
              const symbolLen = data.readUInt32LE(symbolOffset);
              if (symbolLen > 0 && symbolLen < 20) metaPoints += 6;
            }

            // URI present
            const uriOffset = symbolOffset + 4 + (data.readUInt32LE(symbolOffset) || 0);
            if (uriOffset + 4 < data.length) {
              const uriLen = data.readUInt32LE(uriOffset);
              if (uriLen > 0 && uriLen < 500) metaPoints += 6;
            }

            // Has some data = at least partially complete
            if (metaPoints === 0) metaPoints = 3;
          }

          // Cap at 25, give bonus for having all fields
          result.details.metadataScore = Math.min(25, metaPoints + (metaPoints >= 15 ? 6 : 0));
        } else {
          result.details.metadataScore = 0; // No metadata at all
        }
      } catch {
        result.details.metadataScore = 3; // Error checking metadata, give minimal
      }

      // Total score
      result.score = result.details.liquidityScore
        + result.details.holderScore
        + result.details.lockScore
        + result.details.metadataScore;

      // Pass if score > 60
      if (result.score > 60) {
        result.passed = true;
      } else {
        result.rejectReason = `Safety score too low: ${result.score}/100 (min 60)`;
      }

      const elapsed = Date.now() - startMs;
      strategyLog.info(
        {
          token: input.tokenMint.slice(0, 8),
          passed: result.passed,
          score: result.score,
          reason: result.rejectReason,
          elapsed,
          breakdown: {
            liq: result.details.liquidityScore,
            holders: result.details.holderScore,
            lock: result.details.lockScore,
            meta: result.details.metadataScore,
          },
        },
        `Token safety: ${result.passed ? 'PASS' : 'REJECT'}`,
      );

    } catch (err) {
      result.rejectReason = `Safety check error: ${(err as Error).message}`;
      strategyLog.error({ err, token: input.tokenMint }, 'Token safety check failed');
    }

    return result;
  }
}
