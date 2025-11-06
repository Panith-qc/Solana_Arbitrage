// AUTO-CONFIGURATION SERVICE
// Automatically configures all trading parameters based on wallet balance and risk profile
// NO MANUAL CONFIGURATION NEEDED!
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getRiskProfile } from '../config/riskProfiles';
export class AutoConfigService {
    constructor(rpcUrl) {
        Object.defineProperty(this, "connection", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.connection = new Connection(rpcUrl, 'confirmed');
    }
    /**
     * AUTO-CONFIGURE EVERYTHING
     * Just provide wallet address and risk level - we handle the rest!
     */
    async autoConfigureBot(walletAddress, riskLevel) {
        console.log('🤖 AUTO-CONFIGURATION STARTED');
        console.log(`   Wallet: ${walletAddress}`);
        console.log(`   Risk Level: ${riskLevel}`);
        // Step 1: Get wallet balance
        const balance = await this.getWalletBalance(walletAddress);
        console.log(`   Balance: ${balance.toFixed(4)} SOL`);
        // Step 2: Get risk profile
        const profile = getRiskProfile(riskLevel);
        console.log(`   Profile: ${profile.name}`);
        // Step 3: Calculate position sizes based on balance
        const settings = this.calculatePositionSizing(balance, profile);
        // Step 4: Get enabled strategies
        const strategies = this.getEnabledStrategies(profile);
        // Step 5: Validation and warnings
        const warnings = this.validateConfiguration(balance, settings);
        const readyToTrade = warnings.length === 0;
        const config = {
            profile,
            walletBalance: balance,
            calculatedSettings: settings,
            enabledStrategies: strategies,
            readyToTrade,
            warnings,
        };
        this.logConfiguration(config);
        return config;
    }
    /**
     * Get wallet balance in SOL
     */
    async getWalletBalance(address) {
        try {
            const pubkey = new PublicKey(address);
            const balance = await this.connection.getBalance(pubkey);
            return balance / LAMPORTS_PER_SOL;
        }
        catch (error) {
            console.error('❌ Failed to get wallet balance:', error);
            return 0;
        }
    }
    /**
     * Calculate position sizing based on balance and risk profile
     * THIS IS THE MAGIC - Auto-sizes everything!
     */
    calculatePositionSizing(balance, profile) {
        // Calculate max position per trade (% of balance)
        const maxPositionSol = (balance * profile.maxPositionPercent) / 100;
        // Calculate daily limit (% of balance)
        const dailyLimitSol = (balance * profile.dailyLimitPercent) / 100;
        // Calculate max daily loss (% of balance, with minimums)
        const maxDailyLossSol = Math.max((balance * 5) / 100, // 5% of balance
        0.1 // Minimum 0.1 SOL
        );
        // Max trade amount (slightly less than max position for safety)
        const maxTradeAmountSol = maxPositionSol * 0.9;
        return {
            minProfitUsd: profile.minProfitUsd,
            maxPositionSol: Math.min(maxPositionSol, balance * 0.8), // Never more than 80%
            maxDailyLossSol,
            maxTradeAmountSol,
            dailyLimitSol,
            slippageBps: profile.slippageBps,
            priorityFeeLamports: profile.priorityFeeLamports,
            scanIntervalMs: profile.scanIntervalMs,
            stopLossPercent: profile.stopLossPercent,
            maxConcurrentTrades: profile.maxConcurrentTrades,
        };
    }
    /**
     * Get list of enabled strategy names
     */
    getEnabledStrategies(profile) {
        const strategies = [];
        const strats = profile.enabledStrategies;
        if (strats.backrun)
            strategies.push('Backrun');
        if (strats.cyclicArbitrage)
            strategies.push('Cyclic Arbitrage');
        if (strats.jitLiquidity)
            strategies.push('JIT Liquidity');
        if (strats.longTailArbitrage)
            strategies.push('Long-Tail Arbitrage');
        if (strats.microArbitrage)
            strategies.push('Micro Arbitrage');
        if (strats.crossDexArbitrage)
            strategies.push('Cross-DEX Arbitrage');
        if (strats.sandwich)
            strategies.push('Sandwich');
        if (strats.liquidation)
            strategies.push('Liquidation');
        return strategies;
    }
    /**
     * Validate configuration and generate warnings
     */
    validateConfiguration(balance, settings) {
        const warnings = [];
        // Check minimum balance
        if (balance < 0.1) {
            warnings.push('⚠️ Balance too low (< 0.1 SOL). Fund wallet to start trading.');
        }
        else if (balance < 0.5) {
            warnings.push('⚠️ Low balance (< 0.5 SOL). Limited trading opportunities.');
        }
        // Check if positions are too small
        if (settings.maxPositionSol < 0.05) {
            warnings.push('⚠️ Position size very small. Consider adding more capital.');
        }
        // Check if balance is sufficient for gas
        if (balance < 0.2) {
            warnings.push('⚠️ Low balance for gas fees. Reserve at least 0.1 SOL for gas.');
        }
        return warnings;
    }
    /**
     * Log configuration summary
     */
    logConfiguration(config) {
        console.log('\n╔════════════════════════════════════════════════════════╗');
        console.log('║           AUTO-CONFIGURATION COMPLETE                  ║');
        console.log('╚════════════════════════════════════════════════════════╝\n');
        console.log('📊 RISK PROFILE:');
        console.log(`   ${config.profile.name} - ${config.profile.description}`);
        console.log('');
        console.log('💰 WALLET & CAPITAL:');
        console.log(`   Balance: ${config.walletBalance.toFixed(4)} SOL`);
        console.log(`   Max Position: ${config.calculatedSettings.maxPositionSol.toFixed(4)} SOL per trade`);
        console.log(`   Daily Limit: ${config.calculatedSettings.dailyLimitSol.toFixed(4)} SOL per day`);
        console.log(`   Max Daily Loss: ${config.calculatedSettings.maxDailyLossSol.toFixed(4)} SOL`);
        console.log('');
        console.log('🎯 TRADING PARAMETERS:');
        console.log(`   Min Profit: $${config.calculatedSettings.minProfitUsd}`);
        console.log(`   Slippage: ${config.calculatedSettings.slippageBps / 100}%`);
        console.log(`   Stop Loss: ${config.calculatedSettings.stopLossPercent}%`);
        console.log(`   Max Concurrent: ${config.calculatedSettings.maxConcurrentTrades} trades`);
        console.log('');
        console.log('🚀 ENABLED STRATEGIES:');
        config.enabledStrategies.forEach(strategy => {
            console.log(`   ✅ ${strategy}`);
        });
        console.log('');
        console.log('📈 EXPECTED PERFORMANCE:');
        console.log(`   Daily Trades: ${config.profile.expectedDailyTrades}`);
        console.log(`   Success Rate: ${config.profile.expectedSuccessRate}`);
        console.log(`   Daily Return: ${config.profile.expectedDailyReturn}`);
        console.log('');
        if (config.warnings.length > 0) {
            console.log('⚠️  WARNINGS:');
            config.warnings.forEach(warning => console.log(`   ${warning}`));
            console.log('');
        }
        if (config.readyToTrade) {
            console.log('✅ READY TO TRADE! Bot fully configured and operational.');
        }
        else {
            console.log('❌ NOT READY - Address warnings above before trading.');
        }
        console.log('');
        console.log('═══════════════════════════════════════════════════════\n');
    }
    /**
     * Convert AutoConfig to TradingConfig format
     */
    convertToTradingConfig(autoConfig) {
        return {
            trading: {
                minProfitUsd: autoConfig.calculatedSettings.minProfitUsd,
                maxPositionSol: autoConfig.calculatedSettings.maxPositionSol,
                slippageBps: autoConfig.calculatedSettings.slippageBps,
                priorityFeeLamports: autoConfig.calculatedSettings.priorityFeeLamports,
                autoTradingEnabled: true, // ALWAYS ON for auto mode!
                riskLevel: autoConfig.profile.level === 'CONSERVATIVE' ? 'LOW' :
                    autoConfig.profile.level === 'BALANCED' ? 'MEDIUM' : 'HIGH',
                enableSandwich: autoConfig.profile.enabledStrategies.sandwich,
                enableArbitrage: autoConfig.profile.enabledStrategies.crossDexArbitrage,
                enableLiquidation: autoConfig.profile.enabledStrategies.liquidation,
                enableMicroMev: autoConfig.profile.enabledStrategies.microArbitrage,
            },
            scanner: {
                scanIntervalMs: autoConfig.calculatedSettings.scanIntervalMs,
                maxOpportunities: 20,
                circuitBreakerFailureThreshold: 5,
                circuitBreakerRecoveryTimeoutMs: 30000,
                tokenCheckDelayMs: 100,
                profitCaptureRate: 0.85,
            },
            risk: {
                maxTradeAmountSol: autoConfig.calculatedSettings.maxTradeAmountSol,
                maxDailyLossSol: autoConfig.calculatedSettings.maxDailyLossSol,
                stopLossPercent: autoConfig.calculatedSettings.stopLossPercent,
                maxConcurrentTrades: autoConfig.calculatedSettings.maxConcurrentTrades,
                cooldownBetweenTradesMs: 2000,
            },
        };
    }
    /**
     * Quick setup - one function does everything!
     */
    async quickSetup(walletAddress, riskLevel) {
        const config = await this.autoConfigureBot(walletAddress, riskLevel);
        const tradingConfig = this.convertToTradingConfig(config);
        const message = config.readyToTrade
            ? `✅ Bot configured! ${config.enabledStrategies.length} strategies active. Ready to trade with ${config.walletBalance.toFixed(4)} SOL.`
            : `⚠️ Configuration complete but not ready to trade. ${config.warnings.join(' ')}`;
        return {
            config,
            tradingConfig,
            message,
        };
    }
}
// Export singleton instance
export const autoConfigService = new AutoConfigService(import.meta.env.VITE_HELIUS_RPC_URL ||
    'https://mainnet.helius-rpc.com/?api-key=926fd4af-7c9d-4fa3-9504-a2970ac5f16d');
// Helper function for easy use
export async function configureBot(walletAddress, riskLevel = 'BALANCED') {
    return autoConfigService.autoConfigureBot(walletAddress, riskLevel);
}
