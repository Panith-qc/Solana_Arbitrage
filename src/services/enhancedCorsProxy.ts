// ENHANCED CORS PROXY SERVICE - Improved reliability and error handling
// Focuses on working proxies with better fallback strategies

interface ProxyConfig {
  url: string;
  name: string;
  buildUrl: (targetUrl: string) => string;
  headers?: Record<string, string>;
  enabled: boolean;
}

interface ProxyResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface AllOriginsResponse {
  contents?: string;
  [key: string]: unknown;
}

class EnhancedCorsProxyService {
  private readonly PROXY_CONFIGS: ProxyConfig[] = [
    {
      url: 'https://api.allorigins.win/get?url=',
      name: 'AllOrigins',
      buildUrl: (targetUrl: string) => `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`,
      headers: { 'Accept': 'application/json' },
      enabled: true
    },
    {
      url: 'https://corsproxy.org/?',
      name: 'CorsProxy.org',
      buildUrl: (targetUrl: string) => `https://corsproxy.org/?${encodeURIComponent(targetUrl)}`,
      headers: { 'Accept': 'application/json' },
      enabled: true
    },
    {
      url: 'https://proxy.cors.sh/',
      name: 'Cors.sh',
      buildUrl: (targetUrl: string) => `https://proxy.cors.sh/${targetUrl}`,
      headers: { 'Accept': 'application/json' },
      enabled: true
    },
    {
      url: 'https://api.codetabs.com/v1/proxy/?quest=',
      name: 'CodeTabs',
      buildUrl: (targetUrl: string) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(targetUrl)}`,
      headers: { 'Accept': 'application/json' },
      enabled: false // Disabled due to redirect issues
    }
  ];

  private currentProxyIndex = 0;
  private requestCount = 0;
  private successfulRequests = 0;
  private failedRequests = 0;
  private lastSuccessfulProxy: string | null = null;

  constructor() {
    console.log('🌐 ENHANCED CORS PROXY SERVICE - Initialized with improved reliability');
  }

  // Get next available proxy
  private getNextProxy(): ProxyConfig | null {
    const enabledProxies = this.PROXY_CONFIGS.filter(p => p.enabled);
    if (enabledProxies.length === 0) return null;
    
    const proxy = enabledProxies[this.currentProxyIndex % enabledProxies.length];
    return proxy;
  }

  // Switch to next proxy
  private switchToNextProxy(): void {
    const enabledProxies = this.PROXY_CONFIGS.filter(p => p.enabled);
    this.currentProxyIndex = (this.currentProxyIndex + 1) % enabledProxies.length;
  }

  // Make request with enhanced error handling
  async makeRequest(targetUrl: string, options: RequestInit = {}): Promise<unknown> {
    this.requestCount++;
    
    // If we have a last successful proxy, try it first
    if (this.lastSuccessfulProxy) {
      const lastProxy = this.PROXY_CONFIGS.find(p => p.name === this.lastSuccessfulProxy && p.enabled);
      if (lastProxy) {
        try {
          const result = await this.tryProxy(lastProxy, targetUrl, options);
          if (result.success) {
            this.successfulRequests++;
            return result.data;
          }
        } catch (error) {
          console.warn(`⚠️ Last successful proxy ${this.lastSuccessfulProxy} failed, trying others`);
        }
      }
    }

    // Try all available proxies
    const enabledProxies = this.PROXY_CONFIGS.filter(p => p.enabled);
    
    for (let attempt = 0; attempt < enabledProxies.length; attempt++) {
      const proxy = this.getNextProxy();
      if (!proxy) break;

      try {
        console.log(`🌐 Attempting ${proxy.name} proxy (attempt ${attempt + 1}/${enabledProxies.length})`);
        
        const result = await this.tryProxy(proxy, targetUrl, options);
        
        if (result.success) {
          this.successfulRequests++;
          this.lastSuccessfulProxy = proxy.name;
          console.log(`✅ ${proxy.name} proxy successful`);
          return result.data;
        }
        
      } catch (error) {
        console.warn(`⚠️ ${proxy.name} proxy failed:`, error instanceof Error ? error.message : 'Unknown error');
        this.switchToNextProxy();
        
        // Add delay between attempts to avoid rate limiting
        if (attempt < enabledProxies.length - 1) {
          await this.delay(1000 + (attempt * 500)); // Increasing delay
        }
      }
    }

    this.failedRequests++;
    throw new Error(`All ${enabledProxies.length} proxy attempts failed for: ${targetUrl}`);
  }

  // Try a specific proxy
  private async tryProxy(proxy: ProxyConfig, targetUrl: string, options: RequestInit): Promise<ProxyResult> {
    const proxiedUrl = proxy.buildUrl(targetUrl);
    
    const response = await fetch(proxiedUrl, {
      ...options,
      headers: {
        ...proxy.headers,
        ...options.headers
      },
      signal: AbortSignal.timeout(15000) // 15 second timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    let data: unknown;
    const contentType = response.headers.get('content-type');
    
    if (proxy.name === 'AllOrigins') {
      // AllOrigins wraps response in { contents: "..." }
      const wrapper = await response.json() as AllOriginsResponse;
      if (wrapper.contents) {
        try {
          data = JSON.parse(wrapper.contents);
        } catch {
          data = wrapper.contents; // If not JSON, return as string
        }
      } else {
        data = wrapper;
      }
    } else if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const text = await response.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    return { success: true, data };
  }

  // Enhanced fetchWithFallback method for better compatibility
  async fetchWithFallback(url: string, options: RequestInit = {}): Promise<unknown> {
    return await this.makeRequest(url, options);
  }

  // Get Jupiter quote with enhanced reliability
  async getJupiterQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50
  ): Promise<unknown> {
    const jupiterUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
    
    console.log(`📊 Getting Jupiter quote via enhanced proxy: ${inputMint.slice(0, 8)}... → ${outputMint.slice(0, 8)}...`);
    
    try {
      const data = await this.makeRequest(jupiterUrl);
      
      // Enhanced validation for Jupiter quote response
      if (data && typeof data === 'object' && data !== null) {
        const dataObj = data as Record<string, unknown>;
        if (dataObj.outAmount || dataObj.outputAmount) {
          console.log(`✅ Jupiter quote successful: ${dataObj.outAmount || dataObj.outputAmount} output`);
          return data;
        } else {
          // Check if it's a valid quote with different field names
          const possibleOutputFields = ['outAmount', 'outputAmount', 'out_amount', 'output_amount'];
          const outputField = possibleOutputFields.find(field => dataObj[field]);
          
          if (outputField) {
            console.log(`✅ Jupiter quote successful (alt format): ${dataObj[outputField]} output`);
            // Normalize the response format
            return {
              ...dataObj,
              outAmount: dataObj[outputField]
            };
          }
          
          // Log the actual response structure for debugging
          console.warn('⚠️ Jupiter quote response structure:', Object.keys(dataObj));
          throw new Error('Invalid quote response format - missing output amount field');
        }
      } else {
        throw new Error('Invalid quote response format - not an object or missing data');
      }
    } catch (error) {
      console.error(`❌ Jupiter quote failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  // Get Jupiter swap transaction
  async getJupiterSwap(quoteResponse: unknown, userPublicKey: string, priorityFee: number = 200000): Promise<unknown> {
    const jupiterSwapUrl = 'https://quote-api.jup.ag/v6/swap';
    
    console.log(`🔄 Getting Jupiter swap transaction via enhanced proxy`);
    
    try {
      const data = await this.makeRequest(jupiterSwapUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey,
          prioritizationFeeLamports: priorityFee,
          wrapAndUnwrapSol: true,
          useSharedAccounts: true,
          feeAccount: null
        })
      });

      if (data && typeof data === 'object' && data !== null) {
        const dataObj = data as Record<string, unknown>;
        if (dataObj.swapTransaction) {
          console.log(`✅ Jupiter swap transaction successful`);
          return data;
        } else {
          throw new Error('Invalid swap response format');
        }
      } else {
        throw new Error('Invalid swap response format');
      }
    } catch (error) {
      console.error(`❌ Jupiter swap failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  // Health check with better error reporting
  async healthCheck(): Promise<{ healthy: boolean; workingProxies: string[]; failedProxies: string[] }> {
    console.log('🔍 ENHANCED PROXY HEALTH CHECK...');
    
    const testUrl = 'https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000000&slippageBps=50';
    
    const workingProxies: string[] = [];
    const failedProxies: string[] = [];
    
    for (const proxy of this.PROXY_CONFIGS.filter(p => p.enabled)) {
      try {
        const result = await this.tryProxy(proxy, testUrl, {});
        if (result.success) {
          workingProxies.push(proxy.name);
          console.log(`✅ ${proxy.name} proxy health check passed`);
        } else {
          failedProxies.push(proxy.name);
        }
      } catch (error) {
        failedProxies.push(proxy.name);
        console.warn(`⚠️ ${proxy.name} proxy health check failed:`, error instanceof Error ? error.message : 'Unknown error');
      }
    }

    const healthy = workingProxies.length > 0;
    
    if (healthy) {
      console.log(`✅ HEALTH CHECK PASSED - ${workingProxies.length} working proxies: ${workingProxies.join(', ')}`);
    } else {
      console.error(`❌ HEALTH CHECK FAILED - No working proxies available`);
    }

    return { healthy, workingProxies, failedProxies };
  }

  // Utility delay function
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Get comprehensive status
  getStatus() {
    const enabledProxies = this.PROXY_CONFIGS.filter(p => p.enabled);
    const successRate = this.requestCount > 0 ? (this.successfulRequests / this.requestCount * 100).toFixed(1) : '0';
    
    return {
      totalRequests: this.requestCount,
      successfulRequests: this.successfulRequests,
      failedRequests: this.failedRequests,
      successRate: `${successRate}%`,
      enabledProxies: enabledProxies.length,
      currentProxy: enabledProxies[this.currentProxyIndex % enabledProxies.length]?.name || 'None',
      lastSuccessfulProxy: this.lastSuccessfulProxy,
      availableProxies: enabledProxies.map(p => p.name)
    };
  }

  // Enable/disable specific proxy
  setProxyEnabled(proxyName: string, enabled: boolean): void {
    const proxy = this.PROXY_CONFIGS.find(p => p.name === proxyName);
    if (proxy) {
      proxy.enabled = enabled;
      console.log(`🔧 ${proxyName} proxy ${enabled ? 'enabled' : 'disabled'}`);
    }
  }

  // Reset statistics
  resetStats(): void {
    this.requestCount = 0;
    this.successfulRequests = 0;
    this.failedRequests = 0;
    this.lastSuccessfulProxy = null;
    this.currentProxyIndex = 0;
    console.log('🔄 Proxy statistics reset');
  }
}

export const enhancedCorsProxy = new EnhancedCorsProxyService();