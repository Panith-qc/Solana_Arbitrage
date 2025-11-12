// ═══════════════════════════════════════════════════════════════════════════
// ADVANCED MEV SCANNER - NOW USES REAL STRATEGIES
// ═══════════════════════════════════════════════════════════════════════════
// Replaced empty stub with real strategy integration
// Now actually scans for opportunities using Jupiter API
// ═══════════════════════════════════════════════════════════════════════════

import { Keypair } from '@solana/web3.js';
import { realTriangularArbitrage } from './realTriangularArbitrage';
import { realCrossDexArbitrage } from './realCrossDexArbitrage';

interface MEVOpportunity {
  id: string;
  type: string;
  pair: string;
  profitUsd: number;
  profitPercent: number;
  confidence: number;
  riskLevel: string;
  strategyName: string;
  outputMint?: string;
  executionPlan?: string[];
}

class AdvancedMEVScanner {
  private wallet: Keypair | null = null;
  private isScanning = false;
  private accumulatedOpportunities: MEVOpportunity[] = [];

  /**
   * Set wallet for trade execution
   */
  setWallet(wallet: Keypair): void {
    this.wallet = wallet;
    console.log('✅ Advanced MEV Scanner: Wallet set');
  }

  /**
   * Scan for opportunities using REAL strategies
   * No more empty array - this calls real Jupiter API
   */
  async scanOpportunities(capitalSOL: number = 5.0): Promise<MEVOpportunity[]> {
    console.log('🔍 Advanced MEV Scanner: Scanning with real strategies...');

    try {
      const triangularStatus = realTriangularArbitrage.getStatus();
      const crossDexStatus = realCrossDexArbitrage.getStatus();

      // Start scanners if not already running
      if (!triangularStatus.isScanning) {
        console.log('⚡ Advanced MEV Scanner: Starting triangular arbitrage...');
        realTriangularArbitrage.startScanning(
          capitalSOL,
          0.3, // 0.3% minimum profit
          (opportunities) => {
            opportunities.forEach(opp => {
              this.accumulatedOpportunities.push({
                id: opp.id,
                type: 'TRIANGULAR_ARBITRAGE',
                pair: opp.pathNames.join(' → '),
                profitUsd: opp.profitUsd,
                profitPercent: opp.profitPercent,
                confidence: opp.confidence,
                riskLevel: opp.riskLevel,
                strategyName: 'TRIANGULAR_ARBITRAGE',
                outputMint: opp.path[1],
                executionPlan: opp.executionPlan
              });
            });
          }
        );
        this.isScanning = true;
      }

      if (!crossDexStatus.isScanning) {
        console.log('⚡ Advanced MEV Scanner: Starting cross-DEX arbitrage...');
        realCrossDexArbitrage.startScanning(
          capitalSOL,
          0.3,
          (opportunities) => {
            opportunities.forEach(opp => {
              this.accumulatedOpportunities.push({
                id: opp.id,
                type: 'CROSS_DEX_ARBITRAGE',
                pair: opp.pair,
                profitUsd: opp.profitUsd,
                profitPercent: opp.profitPercent,
                confidence: opp.confidence,
                riskLevel: opp.riskLevel,
                strategyName: 'CROSS_DEX_ARBITRAGE',
                outputMint: opp.tokenMint,
                executionPlan: opp.executionPlan
              });
            });
          }
        );
        this.isScanning = true;
      }

      // Clean up old opportunities (older than 5 minutes)
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      this.accumulatedOpportunities = this.accumulatedOpportunities.filter(opp => {
        const oppTime = parseInt(opp.id.split('_')[1]);
        return oppTime > fiveMinutesAgo;
      });

      const currentOpps = [...this.accumulatedOpportunities];
      
      if (currentOpps.length > 0) {
        console.log(`✅ Advanced MEV Scanner: ${currentOpps.length} real opportunities found`);
      } else {
        console.log('ℹ️ Advanced MEV Scanner: No opportunities yet (waiting for scan results...)');
      }

      return currentOpps;

    } catch (error) {
      console.error('❌ Advanced MEV Scanner failed:', error);
      return [];
    }
  }

  /**
   * Stop all scanning
   */
  stopScanning(): void {
    console.log('⏹️ Advanced MEV Scanner: Stopping...');
    this.isScanning = false;
    realTriangularArbitrage.stopScanning();
    realCrossDexArbitrage.stopScanning();
    this.accumulatedOpportunities = [];
  }

  /**
   * Get scanner status
   */
  getStatus() {
    return {
      isScanning: this.isScanning,
      hasWallet: this.wallet !== null,
      opportunityCount: this.accumulatedOpportunities.length,
      triangular: realTriangularArbitrage.getStatus(),
      crossDex: realCrossDexArbitrage.getStatus()
    };
  }
}

export const advancedMEVScanner = new AdvancedMEVScanner();

console.log('✅ Advanced MEV Scanner loaded - Now uses REAL strategies (no more empty stub)');
