import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

serve(async (req) => {
  const requestId = crypto.randomUUID()
  const startTime = Date.now()
  console.log(`[${requestId}] REAL Jupiter Swap Service - ${new Date().toISOString()}`)

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const { quoteResponse, userPublicKey, prioritizationFeeLamports } = body
    
    console.log(`[${requestId}] REAL Swap Request for user: ${userPublicKey?.substring(0, 8)}...`)

    if (!quoteResponse || !userPublicKey) {
      throw new Error('Missing required parameters: quoteResponse and userPublicKey')
    }

    // REAL Jupiter Swap API call - NO MOCK DATA EVER
    const swapUrl = 'https://quote-api.jup.ag/v6/swap'
    
    console.log(`[${requestId}] Calling REAL Jupiter Swap API: ${swapUrl}`)
    
    const response = await fetch(swapUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Solana-MEV-Bot/1.0'
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: prioritizationFeeLamports || 1000
      }),
      signal: AbortSignal.timeout(30000)
    })

    const responseTime = Date.now() - startTime
    console.log(`[${requestId}] Jupiter Swap API response time: ${responseTime}ms`)

    if (!response.ok) {
      console.error(`[${requestId}] Jupiter Swap API HTTP Error: ${response.status} ${response.statusText}`)
      throw new Error(`Jupiter Swap API HTTP Error: ${response.status} ${response.statusText}`)
    }

    const swapData = await response.json()
    console.log(`[${requestId}] REAL Jupiter swap transaction received`)
    
    // Validate this is real swap data
    if (!swapData.swapTransaction) {
      throw new Error('Invalid swap transaction data received from Jupiter API')
    }

    return new Response(JSON.stringify({
      success: true,
      data: swapData,
      requestId,
      responseTime,
      source: 'REAL_JUPITER_SWAP_API',
      timestamp: new Date().toISOString(),
      isReal: true
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    const responseTime = Date.now() - startTime
    console.error(`[${requestId}] REAL Jupiter Swap API FAILED after ${responseTime}ms:`, error.message)
    
    // NEVER return mock data - fail with error instead
    return new Response(JSON.stringify({
      success: false,
      error: `Real Jupiter Swap API failed: ${error.message}`,
      requestId,
      responseTime,
      source: 'REAL_JUPITER_SWAP_API_FAILED',
      timestamp: new Date().toISOString(),
      isReal: false
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})