// DIRECT JUPITER SERVICE - Bypass Supabase proxy completely
// Uses direct API calls with CORS handling
class DirectJupiterService {
    constructor() {
        Object.defineProperty(this, "JUPITER_QUOTE_API", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 'https://quote-api.jup.ag/v6/quote'
        });
        Object.defineProperty(this, "JUPITER_PRICE_API", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 'https://price.jup.ag/v4/price'
        });
        console.log('🎯 DIRECT JUPITER SERVICE - Initialized for real trading');
    }
    // Get quote directly from Jupiter API
    async getQuote(inputMint, outputMint, amount, slippageBps = 100) {
        const requestId = Math.random().toString(36).substring(7);
        console.log(`🔍 [${requestId}] Jupiter Quote Request: ${inputMint.slice(0, 8)}... → ${outputMint.slice(0, 8)}... | Amount: ${amount}`);
        try {
            const url = `${this.JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'MEV-Bot/1.0',
                },
                mode: 'cors',
            });
            if (!response.ok) {
                throw new Error(`Jupiter API returned ${response.status}: ${response.statusText}`);
            }
            const data = await response.json();
            console.log(`✅ [${requestId}] Jupiter quote successful: ${data.outAmount} output for ${data.inAmount} input`);
            return data;
        }
        catch (error) {
            console.error(`❌ [${requestId}] Jupiter quote error:`, error);
            throw error;
        }
    }
    // Get price directly from Jupiter API
    async getPrice(tokenId) {
        const requestId = Math.random().toString(36).substring(7);
        console.log(`💰 [${requestId}] Jupiter Price Request: ${tokenId.slice(0, 8)}...`);
        try {
            const url = `${this.JUPITER_PRICE_API}?ids=${tokenId}`;
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'MEV-Bot/1.0',
                },
                mode: 'cors',
            });
            if (!response.ok) {
                throw new Error(`Jupiter Price API returned ${response.status}: ${response.statusText}`);
            }
            const data = await response.json();
            console.log(`✅ [${requestId}] Jupiter price successful: $${data.data[tokenId]?.price || 'N/A'}`);
            return data;
        }
        catch (error) {
            console.error(`❌ [${requestId}] Jupiter price error:`, error);
            throw error;
        }
    }
    // Test connectivity
    async testConnection() {
        try {
            console.log('🧪 Testing direct Jupiter API connectivity...');
            // Test with SOL → USDC quote
            await this.getQuote('So11111111111111111111111111111111111111112', // SOL
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            '100000000', // 0.1 SOL
            100);
            console.log('✅ Direct Jupiter API connection test passed');
            return true;
        }
        catch (error) {
            console.error('❌ Direct Jupiter API connection test failed:', error);
            return false;
        }
    }
}
export const directJupiterService = new DirectJupiterService();
