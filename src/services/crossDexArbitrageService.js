import { microArbitrageService } from './microArbitrageService';
class CrossDexArbitrageService {
    constructor() {
        Object.defineProperty(this, "isScanning", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "scanInterval", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "callback", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
    }
    setCallback(callback) {
        this.callback = callback;
    }
    async startArbitrageScanning() {
        if (this.isScanning) {
            console.log('⚠️ Arbitrage scanning already active');
            return;
        }
        console.log('🔄 Starting arbitrage scanning...');
        this.isScanning = true;
        const scanForArbitrageOpportunities = async () => {
            try {
                const opportunities = await this.scanForArbitrageOpportunities();
                if (this.callback && opportunities.length > 0) {
                    this.callback(opportunities);
                }
            }
            catch (error) {
                console.error('❌ Arbitrage scan failed:', error);
            }
        };
        // Initial scan
        await scanForArbitrageOpportunities();
        // Set up interval scanning
        this.scanInterval = setInterval(scanForArbitrageOpportunities, 10000); // 10 seconds
    }
    stopArbitrageScanning() {
        console.log('⏹️ Stopping arbitrage scanning...');
        this.isScanning = false;
        if (this.scanInterval) {
            clearInterval(this.scanInterval);
            this.scanInterval = null;
        }
    }
    // Add the missing stopScanning method
    stopScanning() {
        this.stopArbitrageScanning();
    }
    async scanForArbitrageOpportunities() {
        const opportunities = [];
        // Mock opportunities for now
        const mockOpportunity = {
            id: `arb_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            pair: 'SOL/USDC',
            profit: 0.025,
            volume: 1000,
            type: 'ARBITRAGE',
            exchange1: 'Jupiter',
            exchange2: 'Raydium',
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            capitalRequired: 100
        };
        opportunities.push(mockOpportunity);
        return opportunities;
    }
    async executeArbitrage(opportunityId) {
        console.log(`🚀 Executing arbitrage: ${opportunityId}`);
        try {
            // Find the opportunity (mock for now)
            const opportunity = {
                id: opportunityId,
                pair: 'SOL/USDC',
                profit: 0.025,
                capitalRequired: 0.1,
                type: 'ARBITRAGE'
            };
            // Use the microArbitrageService for execution
            const result = await microArbitrageService.executeArbitrage(opportunity);
            return result.success;
        }
        catch (error) {
            console.error('❌ Arbitrage execution failed:', error);
            return false;
        }
    }
}
export const crossDexArbitrageService = new CrossDexArbitrageService();
