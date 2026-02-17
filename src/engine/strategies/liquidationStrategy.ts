// LIQUIDATION STRATEGY
// Monitors Solana lending protocols (Solend, MarginFi) for under-collateralized
// positions. When a position's health factor drops below 1.0, it becomes
// liquidatable: we repay the borrower's debt, claim their collateral at a
// discount, and sell the collateral back to SOL.
//
// Currently implemented as infrastructure/framework with interfaces and program
// IDs in place. The actual on-chain account parsing will be filled in as each
// protocol's account layout is integrated.

import crypto from 'crypto';
import { BaseStrategy, Opportunity, StrategyConfig } from './baseStrategy.js';
import { strategyLog } from '../logger.js';
import {
  SOL_MINT,
  LAMPORTS_PER_SOL,
  BotConfig,
  RiskProfile,
} from '../config.js';
import { ConnectionManager } from '../connectionManager.js';

// ── Lending Protocol Program IDs ───────────────────────────────────────────────
const SOLEND_PROGRAM_ID = 'So1endDq2YkqhipRh3WViPa8hFb7VGGKJhqoJdFt8iV';
const MARGINFI_PROGRAM_ID = 'MFv2hWf31Z9kbCa1snEPYctwafyhdg97gDV7T3x4Go8';

// ── Constants ──────────────────────────────────────────────────────────────────
const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const QUOTE_LIFETIME_MS = 20_000;           // liquidation quotes are less time-sensitive
const LIQUIDATION_BONUS_BPS = 500;          // typical 5% liquidation bonus
const BASE_GAS_LAMPORTS = 5_000;
const PRIORITY_FEE_LAMPORTS = 200_000;      // higher priority for liquidation races

// ── Interfaces ─────────────────────────────────────────────────────────────────

/** Represents a lending position that may be liquidatable. */
export interface LendingPosition {
  protocol: 'solend' | 'marginfi';
  obligationAddress: string;    // on-chain account address
  owner: string;                // borrower's wallet
  collateralMint: string;
  collateralAmountRaw: string;  // raw token amount
  collateralValueUsd: number;
  debtMint: string;
  debtAmountRaw: string;
  debtValueUsd: number;
  healthFactor: number;         // < 1.0 means liquidatable
  maxLiquidationUsd: number;    // max amount that can be liquidated in one TX
  liquidationBonus: number;     // protocol-specific bonus (fraction, e.g. 0.05 = 5%)
}

/** Result of a liquidation opportunity analysis. */
interface LiquidationAnalysis {
  position: LendingPosition;
  repayAmountRaw: string;
  collateralClaimRaw: string;
  collateralValueSol: number;
  repayCostSol: number;
  liquidationBonusSol: number;
  netProfitSol: number;
  netProfitUsd: number;
  fees: { gas: number; priority: number; slippage: number; total: number };
}

/** Provider interface for protocol-specific position monitoring. */
export interface LendingProtocolProvider {
  name: string;
  programId: string;
  fetchAtRiskPositions(): Promise<LendingPosition[]>;
  buildLiquidationInstruction(position: LendingPosition, repayAmount: string): Promise<any>;
}

export class LiquidationStrategy extends BaseStrategy {
  private connectionManager: ConnectionManager;
  private botConfig: BotConfig;
  private riskProfile: RiskProfile;
  private providers: LendingProtocolProvider[] = [];

  constructor(connectionManager: ConnectionManager, config: BotConfig, riskProfile: RiskProfile) {
    const strategyConfig: StrategyConfig = {
      name: 'liquidation',
      enabled: riskProfile.strategies.liquidation,
      scanIntervalMs: 10_000,  // every 10s
      minProfitUsd: riskProfile.minProfitUsd,
      maxPositionSol: riskProfile.maxPositionSol,
      slippageBps: riskProfile.slippageBps,
    };
    super(strategyConfig);

    this.connectionManager = connectionManager;
    this.botConfig = config;
    this.riskProfile = riskProfile;

    // Register built-in providers
    this.registerDefaultProviders();
  }

  getName(): string {
    return 'Liquidation';
  }

  /** Register a custom lending protocol provider. */
  registerProvider(provider: LendingProtocolProvider): void {
    this.providers.push(provider);
    strategyLog.info({ provider: provider.name, programId: provider.programId }, 'Liquidation provider registered');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // DEFAULT PROVIDERS (framework stubs)
  // ────────────────────────────────────────────────────────────────────────────

  private registerDefaultProviders(): void {
    // Solend provider
    this.providers.push({
      name: 'Solend',
      programId: SOLEND_PROGRAM_ID,
      fetchAtRiskPositions: () => this.fetchSolendPositions(),
      buildLiquidationInstruction: (pos, amount) => this.buildSolendLiquidation(pos, amount),
    });

    // MarginFi provider
    this.providers.push({
      name: 'MarginFi',
      programId: MARGINFI_PROGRAM_ID,
      fetchAtRiskPositions: () => this.fetchMarginFiPositions(),
      buildLiquidationInstruction: (pos, amount) => this.buildMarginFiLiquidation(pos, amount),
    });

    strategyLog.info(
      { providers: this.providers.map(p => p.name) },
      'Default liquidation providers registered',
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SCAN
  // ────────────────────────────────────────────────────────────────────────────

  async scan(): Promise<Opportunity[]> {
    if (!this.isActive()) return [];

    this.scanCount++;
    const opportunities: Opportunity[] = [];

    for (const provider of this.providers) {
      try {
        const positions = await provider.fetchAtRiskPositions();

        for (const position of positions) {
          // Only liquidate positions with health factor < 1.0
          if (position.healthFactor >= 1.0) continue;

          const analysis = await this.analyzeLiquidation(position);
          if (!analysis) continue;

          if (analysis.netProfitUsd >= this.config.minProfitUsd) {
            const now = Date.now();
            const opportunity: Opportunity = {
              id: crypto.randomUUID(),
              strategy: this.name,
              tokenPath: ['SOL', position.collateralMint, 'SOL'],
              mintPath: [SOL_MINT, position.collateralMint, SOL_MINT],
              inputAmountLamports: BigInt(Math.round(analysis.repayCostSol * LAMPORTS_PER_SOL)),
              expectedOutputLamports: BigInt(Math.round((analysis.repayCostSol + analysis.netProfitSol) * LAMPORTS_PER_SOL)),
              expectedProfitSol: analysis.netProfitSol,
              expectedProfitUsd: analysis.netProfitUsd,
              confidence: this.estimateConfidence(position, analysis),
              quotes: [],
              metadata: {
                type: 'liquidation',
                protocol: position.protocol,
                obligationAddress: position.obligationAddress,
                borrower: position.owner,
                healthFactor: position.healthFactor,
                collateralMint: position.collateralMint,
                debtMint: position.debtMint,
                collateralValueUsd: position.collateralValueUsd,
                debtValueUsd: position.debtValueUsd,
                liquidationBonusSol: analysis.liquidationBonusSol,
                repayAmountRaw: analysis.repayAmountRaw,
                collateralClaimRaw: analysis.collateralClaimRaw,
                fees: analysis.fees,
              },
              timestamp: now,
              expiresAt: now + QUOTE_LIFETIME_MS,
            };

            opportunities.push(opportunity);
            this.opportunitiesFound++;

            strategyLog.info(
              {
                protocol: position.protocol,
                obligation: position.obligationAddress.slice(0, 12) + '...',
                healthFactor: position.healthFactor.toFixed(4),
                collateralUsd: position.collateralValueUsd.toFixed(2),
                netProfitUsd: analysis.netProfitUsd.toFixed(4),
              },
              'Liquidation opportunity found',
            );
          }
        }
      } catch (err) {
        strategyLog.error({ err, provider: provider.name }, 'Error scanning liquidation provider');
      }
    }

    opportunities.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd);

    strategyLog.debug(
      { found: opportunities.length, scanCount: this.scanCount },
      'Liquidation scan complete',
    );

    return opportunities;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // LIQUIDATION ANALYSIS
  // ────────────────────────────────────────────────────────────────────────────

  private async analyzeLiquidation(position: LendingPosition): Promise<LiquidationAnalysis | null> {
    try {
      const bonus = position.liquidationBonus || LIQUIDATION_BONUS_BPS / 10_000;

      // How much collateral we receive for repaying the debt
      const maxRepayUsd = Math.min(
        position.maxLiquidationUsd,
        this.riskProfile.maxTradeAmountSol * 150,  // roughly maxTrade in USD
      );

      // Collateral we claim = repay * (1 + bonus)
      const collateralClaimUsd = maxRepayUsd * (1 + bonus);
      const liquidationBonusUsd = maxRepayUsd * bonus;

      // Convert to SOL (rough estimate)
      const solPriceUsd = 150;
      const repayCostSol = maxRepayUsd / solPriceUsd;
      const collateralValueSol = collateralClaimUsd / solPriceUsd;
      const liquidationBonusSol = liquidationBonusUsd / solPriceUsd;

      // Fees for the liquidation TX + selling collateral
      const gas = (BASE_GAS_LAMPORTS * 2) / LAMPORTS_PER_SOL;  // liquidate + sell collateral
      const priority = PRIORITY_FEE_LAMPORTS / LAMPORTS_PER_SOL;
      const slippage = collateralValueSol * (this.config.slippageBps / 10_000);
      const totalFees = gas + priority + slippage;

      const netProfitSol = liquidationBonusSol - totalFees;
      const netProfitUsd = netProfitSol * solPriceUsd;

      return {
        position,
        repayAmountRaw: position.debtAmountRaw,
        collateralClaimRaw: position.collateralAmountRaw,
        collateralValueSol,
        repayCostSol,
        liquidationBonusSol,
        netProfitSol,
        netProfitUsd,
        fees: { gas, priority, slippage, total: totalFees },
      };
    } catch (err) {
      strategyLog.error({ err, obligation: position.obligationAddress }, 'Failed to analyze liquidation');
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PROTOCOL-SPECIFIC FETCHERS (stubs - to be implemented with account parsing)
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Fetch at-risk positions from Solend.
   * In production, this would:
   *   1. Query Solend's obligation accounts via getProgramAccounts
   *   2. Deserialize the account data using Solend's IDL
   *   3. Calculate health factor from collateral/debt ratios
   *   4. Return positions with health factor < 1.05 (approaching liquidation)
   */
  private async fetchSolendPositions(): Promise<LendingPosition[]> {
    try {
      const connection = this.connectionManager.getConnection();

      // Framework: query Solend program accounts
      // In production, use:
      //   const accounts = await connection.getProgramAccounts(
      //     new PublicKey(SOLEND_PROGRAM_ID),
      //     { filters: [/* obligation account discriminator */] }
      //   );
      // Then deserialize each account and calculate health factor.

      strategyLog.debug('Solend position scan (framework stub)');
      return [];
    } catch (err) {
      strategyLog.error({ err }, 'Error fetching Solend positions');
      return [];
    }
  }

  /**
   * Fetch at-risk positions from MarginFi.
   * In production, this would:
   *   1. Query MarginFi's marginfi_account accounts
   *   2. Deserialize using MarginFi's IDL
   *   3. Calculate health from asset/liability weights
   *   4. Return positions nearing liquidation
   */
  private async fetchMarginFiPositions(): Promise<LendingPosition[]> {
    try {
      const connection = this.connectionManager.getConnection();

      // Framework: query MarginFi program accounts
      // In production, use:
      //   const accounts = await connection.getProgramAccounts(
      //     new PublicKey(MARGINFI_PROGRAM_ID),
      //     { filters: [/* marginfi_account discriminator */] }
      //   );

      strategyLog.debug('MarginFi position scan (framework stub)');
      return [];
    } catch (err) {
      strategyLog.error({ err }, 'Error fetching MarginFi positions');
      return [];
    }
  }

  /**
   * Build a Solend liquidation instruction.
   * Framework stub - in production, construct the actual IX using Solend's SDK.
   */
  private async buildSolendLiquidation(position: LendingPosition, repayAmount: string): Promise<any> {
    strategyLog.debug(
      { obligation: position.obligationAddress, repayAmount },
      'Building Solend liquidation instruction (stub)',
    );
    return {
      programId: SOLEND_PROGRAM_ID,
      type: 'liquidateObligation',
      obligationAddress: position.obligationAddress,
      repayAmount,
    };
  }

  /**
   * Build a MarginFi liquidation instruction.
   * Framework stub - in production, construct the actual IX using MarginFi's SDK.
   */
  private async buildMarginFiLiquidation(position: LendingPosition, repayAmount: string): Promise<any> {
    strategyLog.debug(
      { obligation: position.obligationAddress, repayAmount },
      'Building MarginFi liquidation instruction (stub)',
    );
    return {
      programId: MARGINFI_PROGRAM_ID,
      type: 'liquidate',
      marginfiAccount: position.obligationAddress,
      repayAmount,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CONFIDENCE
  // ────────────────────────────────────────────────────────────────────────────

  private estimateConfidence(position: LendingPosition, analysis: LiquidationAnalysis): number {
    if (analysis.netProfitSol <= 0) return 0;

    // Lower health factor = more certain liquidation is possible
    let confidence = 0.5;

    if (position.healthFactor < 0.8) confidence += 0.2;
    else if (position.healthFactor < 0.9) confidence += 0.1;

    // Higher margin = more confidence
    const marginRatio = analysis.netProfitSol / analysis.fees.total;
    confidence += Math.min(0.2, marginRatio / 10);

    return parseFloat(Math.min(0.90, Math.max(0.05, confidence)).toFixed(4));
  }
}
