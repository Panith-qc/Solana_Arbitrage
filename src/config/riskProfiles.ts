// RISK PROFILES - PRESET CONFIGURATIONS FOR AUTOMATED TRADING
// User selects one profile, bot auto-configures everything

export type RiskLevel = 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';

export interface RiskProfile {
  name: string;
  description: string;
  level: RiskLevel;
  
  // Profit thresholds
  minProfitUsd: number;
  minProfitPercent: number;
  
  // Position sizing (percentage of total balance)
  maxPositionPercent: number; // Max % of balance per trade
  dailyLimitPercent: number;  // Max % of balance per day
  
  // Risk management
  stopLossPercent: number;
  maxConcurrentTrades: number;
  maxDailyLossSol: number; // Calculated based on balance
  
  // Trading parameters
  slippageBps: number;
  priorityFeeLamports: number;
  scanIntervalMs: number;
  
  // Strategy selection
  enabledStrategies: {
    backrun: boolean;
    cyclicArbitrage: boolean;
    jitLiquidity: boolean;
    longTailArbitrage: boolean;
    microArbitrage: boolean;
    crossDexArbitrage: boolean;
    sandwich: boolean;
    liquidation: boolean;
  };
  
  // Performance expectations
  expectedDailyTrades: string;
  expectedSuccessRate: string;
  expectedDailyReturn: string;
}

// CONSERVATIVE PROFILE - Safest, lowest risk
export const CONSERVATIVE_PROFILE: RiskProfile = {
  name: 'Conservative',
  description: 'Lowest risk, safest strategies only. Best for beginners or risk-averse traders.',
  level: 'CONSERVATIVE',
  
  // Higher profit thresholds = fewer but safer trades
  minProfitUsd: 0.10,
  minProfitPercent: 1.0, // 1% minimum profit
  
  // Small positions
  maxPositionPercent: 10, // Only 10% of balance per trade
  dailyLimitPercent: 30,  // Max 30% of balance per day
  
  // Tight risk controls
  stopLossPercent: 2.0,
  maxConcurrentTrades: 2,
  maxDailyLossSol: 0.5, // Will be adjusted based on balance
  
  // Conservative trading parameters
  slippageBps: 50,  // 0.5% slippage
  priorityFeeLamports: 100000, // Higher priority for safety
  scanIntervalMs: 5000, // Slower, more careful
  
  // Only safest strategies
  enabledStrategies: {
    backrun: false,           // Too fast/risky for conservative
    cyclicArbitrage: true,    // ✅ Safe, predictable
    jitLiquidity: false,      // Requires precise timing
    longTailArbitrage: true,  // ✅ Safe, less competition
    microArbitrage: true,     // ✅ Safe, small amounts
    crossDexArbitrage: true,  // ✅ Safe, simple
    sandwich: false,          // Too risky
    liquidation: false,       // Too risky
  },
  
  expectedDailyTrades: '5-15 trades',
  expectedSuccessRate: '80-90%',
  expectedDailyReturn: '0.5-2% of capital',
};

// BALANCED PROFILE - Moderate risk, good balance
export const BALANCED_PROFILE: RiskProfile = {
  name: 'Balanced',
  description: 'Balanced risk/reward. Good mix of strategies for consistent returns.',
  level: 'BALANCED',
  
  // Moderate profit thresholds
  minProfitUsd: 0.05,
  minProfitPercent: 0.5, // 0.5% minimum profit
  
  // Moderate positions
  maxPositionPercent: 25, // 25% of balance per trade
  dailyLimitPercent: 50,  // Max 50% of balance per day
  
  // Moderate risk controls
  stopLossPercent: 3.0,
  maxConcurrentTrades: 3,
  maxDailyLossSol: 1.0, // Will be adjusted based on balance
  
  // Balanced trading parameters
  slippageBps: 100, // 1.0% slippage
  priorityFeeLamports: 50000,
  scanIntervalMs: 3000, // Moderate speed
  
  // Most strategies enabled
  enabledStrategies: {
    backrun: true,            // ✅ Good for active trading
    cyclicArbitrage: true,    // ✅ Core strategy
    jitLiquidity: true,       // ✅ Good fee capture
    longTailArbitrage: true,  // ✅ Good margins
    microArbitrage: true,     // ✅ Frequent small wins
    crossDexArbitrage: true,  // ✅ Core strategy
    sandwich: false,          // Still too risky
    liquidation: true,        // ✅ Good opportunities
  },
  
  expectedDailyTrades: '20-50 trades',
  expectedSuccessRate: '75-85%',
  expectedDailyReturn: '1-5% of capital',
};

// AGGRESSIVE PROFILE - Highest risk, maximum returns
export const AGGRESSIVE_PROFILE: RiskProfile = {
  name: 'Aggressive',
  description: 'Maximum risk/reward. All strategies enabled for experienced traders only.',
  level: 'AGGRESSIVE',
  
  // Low profit thresholds = more trades
  minProfitUsd: 0.02,
  minProfitPercent: 0.2, // 0.2% minimum profit
  
  // Large positions
  maxPositionPercent: 50, // 50% of balance per trade
  dailyLimitPercent: 100, // Can use full balance
  
  // Aggressive risk controls
  stopLossPercent: 5.0,
  maxConcurrentTrades: 5,
  maxDailyLossSol: 2.0, // Will be adjusted based on balance
  
  // Aggressive trading parameters
  slippageBps: 150, // 1.5% slippage for speed
  priorityFeeLamports: 200000, // Very high priority
  scanIntervalMs: 1000, // Very fast scanning
  
  // ALL strategies enabled
  enabledStrategies: {
    backrun: true,            // ✅ Fast profits
    cyclicArbitrage: true,    // ✅ Core strategy
    jitLiquidity: true,       // ✅ Fee capture
    longTailArbitrage: true,  // ✅ Good margins
    microArbitrage: true,     // ✅ Frequent trades
    crossDexArbitrage: true,  // ✅ Core strategy
    sandwich: true,           // ✅ High risk/reward
    liquidation: true,        // ✅ Good opportunities
  },
  
  expectedDailyTrades: '50-150 trades',
  expectedSuccessRate: '70-80%',
  expectedDailyReturn: '3-10% of capital',
};

// Profile registry
export const RISK_PROFILES: Record<RiskLevel, RiskProfile> = {
  CONSERVATIVE: CONSERVATIVE_PROFILE,
  BALANCED: BALANCED_PROFILE,
  AGGRESSIVE: AGGRESSIVE_PROFILE,
};

// Get profile by level
export function getRiskProfile(level: RiskLevel): RiskProfile {
  return RISK_PROFILES[level];
}

// Get all available profiles
export function getAllRiskProfiles(): RiskProfile[] {
  return [CONSERVATIVE_PROFILE, BALANCED_PROFILE, AGGRESSIVE_PROFILE];
}

// Helper to display profile info
export function getProfileSummary(level: RiskLevel): string {
  const profile = getRiskProfile(level);
  return `
${profile.name} Profile:
- Daily Trades: ${profile.expectedDailyTrades}
- Success Rate: ${profile.expectedSuccessRate}
- Daily Return: ${profile.expectedDailyReturn}
- Max Position: ${profile.maxPositionPercent}% of balance
- Stop Loss: ${profile.stopLossPercent}%
  `.trim();
}
