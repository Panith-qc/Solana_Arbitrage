import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

serve(async (req) => {
  const requestId = crypto.randomUUID()
  const startTime = Date.now()
  console.log(`[${requestId}] REAL CoinGecko Price Service - ${new Date().toISOString()}`)

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const { tokens } = body
    
    // Default to SOL and USDC if no tokens specified
    const tokenIds = tokens || ['solana', 'usd-coin']
    const tokenString = tokenIds.join(',')
    
    console.log(`[${requestId}] Fetching REAL prices for: ${tokenString}`)

    // REAL CoinGecko API call - NO MOCK DATA EVER
    const coingeckoUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${tokenString}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`
    
    console.log(`[${requestId}] Calling REAL CoinGecko API: ${coingeckoUrl}`)
    
    const response = await fetch(coingeckoUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Solana-MEV-Bot/1.0'
      },
      signal: AbortSignal.timeout(15000)
    })

    const responseTime = Date.now() - startTime
    console.log(`[${requestId}] CoinGecko API response time: ${responseTime}ms`)

    if (!response.ok) {
      console.error(`[${requestId}] CoinGecko API HTTP Error: ${response.status} ${response.statusText}`)
      throw new Error(`CoinGecko API HTTP Error: ${response.status} ${response.statusText}`)
    }

    const priceData = await response.json()
    console.log(`[${requestId}] REAL CoinGecko prices received:`, Object.keys(priceData))
    
    // Validate this is real data
    if (!priceData || Object.keys(priceData).length === 0) {
      throw new Error('Invalid price data received from CoinGecko API')
    }

    // Log real price details
    for (const [token, data] of Object.entries(priceData)) {
      console.log(`[${requestId}] ${token}: $${data.usd}, 24h change: ${data.usd_24h_change}%`)
    }

    return new Response(JSON.stringify({
      success: true,
      data: priceData,
      requestId,
      responseTime,
      source: 'REAL_COINGECKO_API',
      timestamp: new Date().toISOString(),
      isReal: true
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    const responseTime = Date.now() - startTime
    console.error(`[${requestId}] REAL CoinGecko API FAILED after ${responseTime}ms:`, error.message)
    
    // NEVER return mock data - fail with error instead
    return new Response(JSON.stringify({
      success: false,
      error: `Real CoinGecko API failed: ${error.message}`,
      requestId,
      responseTime,
      source: 'REAL_COINGECKO_API_FAILED',
      timestamp: new Date().toISOString(),
      isReal: false
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})