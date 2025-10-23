// ENHANCED CORS PROXY SERVICE - Updated to use WORKING fallback proxy
// Uses app_19a63e71b8_jupiter_fallback_proxy which actually works

class EnhancedCorsProxyService {
  private supabaseUrl = 'https://jxwynzsxyxzohlhkqmpt.supabase.co';
  private supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4d3luenN4eXh6b2hsaGtxbXB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcwMjEyNDQsImV4cCI6MjA3MjU5NzI0NH0.69aj1AhvM0k7N788A7MRenHLBayd8aYjTs6UOYYvILY';

  async healthCheck(): Promise<{ supabase: boolean; direct: boolean; external: boolean }> {
    const results = {
      supabase: false,
      direct: false,
      external: false
    };

    // Test WORKING fallback proxy
    try {
      const response = await fetch(`${this.supabaseUrl}/functions/v1/app_19a63e71b8_jupiter_fallback_proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.supabaseKey}`
        },
        body: JSON.stringify({
          action: 'health'
        })
      });
      
      const result = await response.json();
      results.supabase = response.ok && result.success;
    } catch (error) {
      console.error('Working proxy health check failed:', error);
    }

    return results;
  }

  async fetch(url: string): Promise<Response> {
    console.log('🌐 Using WORKING fallback proxy instead of broken external URL...');
    
    // Parse the URL to extract parameters
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    
    // Handle different Jupiter API endpoints
    if (path.includes('/price')) {
      // Price API request - convert to quote request
      const ids = urlObj.searchParams.get('ids');
      if (ids) {
        return fetch(`${this.supabaseUrl}/functions/v1/app_19a63e71b8_jupiter_fallback_proxy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.supabaseKey}`
          },
          body: JSON.stringify({
            action: 'quote',
            inputMint: ids,
            outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            amount: '1000000000',
            slippageBps: 50
          })
        });
      }
    }
    
    if (path.includes('/quote')) {
      // Quote API request
      const params = Object.fromEntries(urlObj.searchParams.entries());
      return fetch(`${this.supabaseUrl}/functions/v1/app_19a63e71b8_jupiter_fallback_proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.supabaseKey}`
        },
        body: JSON.stringify({
          action: 'quote',
          inputMint: params.inputMint,
          outputMint: params.outputMint,
          amount: params.amount,
          slippageBps: parseInt(params.slippageBps) || 50
        })
      });
    }

    // Default fallback
    return fetch(`${this.supabaseUrl}/functions/v1/app_19a63e71b8_jupiter_fallback_proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.supabaseKey}`
      },
      body: JSON.stringify({
        action: 'health'
      })
    });
  }
}

// Export both named and default exports to fix import issues
export const enhancedCorsProxyService = new EnhancedCorsProxyService();
export const enhancedCorsProxy = enhancedCorsProxyService;
export default enhancedCorsProxyService;