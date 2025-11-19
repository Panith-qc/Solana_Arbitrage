// CORS PROXY SERVICE - Bypass CORS restrictions for Jupiter API
// Uses multiple proxy services as fallbacks
class CorsProxyService {
    constructor() {
        Object.defineProperty(this, "PROXY_URLS", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: [
                'https://api.allorigins.win/raw?url=',
                'https://cors-anywhere.herokuapp.com/',
                'https://thingproxy.freeboard.io/fetch/',
                'https://api.codetabs.com/v1/proxy?quest='
            ]
        });
        Object.defineProperty(this, "currentProxyIndex", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "maxRetries", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 3
        });
        console.log('🌐 CORS PROXY SERVICE - Initialized with multiple proxy fallbacks');
    }
    // Get the current proxy URL
    getCurrentProxy() {
        return this.PROXY_URLS[this.currentProxyIndex % this.PROXY_URLS.length];
    }
    // Switch to next proxy on failure
    switchProxy() {
        this.currentProxyIndex = (this.currentProxyIndex + 1) % this.PROXY_URLS.length;
        console.log(`🔄 Switching to proxy: ${this.getCurrentProxy()}`);
    }
    // Make proxied request with fallback
    async proxyFetch(url, options = {}) {
        let lastError = null;
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            try {
                const proxy = this.getCurrentProxy();
                const proxiedUrl = `${proxy}${encodeURIComponent(url)}`;
                console.log(`🌐 Attempt ${attempt + 1}: Using proxy ${proxy}`);
                const response = await fetch(proxiedUrl, {
                    ...options,
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        ...options.headers
                    }
                });
                if (response.ok) {
                    console.log(`✅ Proxy request successful via ${proxy}`);
                    return response;
                }
                else {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
            }
            catch (error) {
                lastError = error;
                console.warn(`⚠️ Proxy attempt ${attempt + 1} failed:`, error);
                if (attempt < this.maxRetries - 1) {
                    this.switchProxy();
                    // Wait before retry
                    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
                }
            }
        }
        throw lastError || new Error('All proxy attempts failed');
    }
    // Direct fetch without proxy (fallback)
    async directFetch(url, options = {}) {
        console.log('🎯 Attempting direct fetch (no proxy)');
        try {
            const response = await fetch(url, {
                ...options,
                mode: 'cors',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });
            if (response.ok) {
                console.log('✅ Direct fetch successful');
                return response;
            }
            else {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        }
        catch (error) {
            console.warn('⚠️ Direct fetch failed:', error);
            throw error;
        }
    }
    // Smart fetch - tries direct first, then proxy
    async smartFetch(url, options = {}) {
        try {
            // Try direct fetch first (fastest if it works)
            return await this.directFetch(url, options);
        }
        catch (directError) {
            console.log('📡 Direct fetch failed, trying proxy...');
            try {
                // Fallback to proxy
                return await this.proxyFetch(url, options);
            }
            catch (proxyError) {
                console.error('❌ Both direct and proxy requests failed');
                const directMsg = directError instanceof Error ? directError.message : 'Unknown error';
                const proxyMsg = proxyError instanceof Error ? proxyError.message : 'Unknown error';
                throw new Error(`Network request failed: Direct (${directMsg}), Proxy (${proxyMsg})`);
            }
        }
    }
    // Get proxy status
    getStatus() {
        return {
            currentProxy: this.getCurrentProxy(),
            proxyIndex: this.currentProxyIndex,
            totalProxies: this.PROXY_URLS.length
        };
    }
    // Reset proxy to first one
    reset() {
        this.currentProxyIndex = 0;
        console.log('🔄 Proxy service reset to first proxy');
    }
}
export const corsProxyService = new CorsProxyService();
