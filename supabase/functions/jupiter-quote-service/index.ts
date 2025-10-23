import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

serve(async (req) => {
  const requestId = crypto.randomUUID()
  const startTime = Date.now()
  console.log(`[${requestId}] REAL Jupiter Quote Service - ${new Date().toISOString()}`)

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const { inputMint, outputMint, amount, slippageBps } = body
    
    console.log(`[${requestId}] REAL API Request: ${inputMint} -> ${outputMint}, amount: ${amount}`)

    // REAL Jupiter API call - NO MOCK DATA EVER
    const jupiterUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps || 50}`
    
    console.log(`[${requestId}] Calling REAL Jupiter API: ${jupiterUrl}`)
    
    const response = await fetch(jupiterUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Solana-MEV-Bot/1.0',
        'Cache-Control': 'no-cache'
      },
      signal: AbortSignal.timeout(30000) // 30 second timeout
    })

    const responseTime = Date.now() - startTime
    console.log(`[${requestId}] Jupiter API response time: ${responseTime}ms`)

    if (!response.ok) {
      console.error(`[${requestId}] Jupiter API HTTP Error: ${response.status} ${response.statusText}`)
      throw new Error(`Jupiter API HTTP Error: ${response.status} ${response.statusText}`)
    }

    const quoteData = await response.json()
    console.log(`[${requestId}] REAL Jupiter quote received: inAmount=${quoteData.inAmount}, outAmount=${quoteData.outAmount}`)
    
    // Validate this is real data, not mock
    if (!quoteData.inAmount || !quoteData.outAmount || !quoteData.routePlan) {
      throw new Error('Invalid quote data received from Jupiter API')
    }

    // Log the real route plan
    console.log(`[${requestId}] Real route plan: ${JSON.stringify(quoteData.routePlan[0]?.swapInfo?.label || 'No label')}`)

    return new Response(JSON.stringify({
      success: true,
      data: quoteData,
      requestId,
      responseTime,
      source: 'REAL_JUPITER_API',
      timestamp: new Date().toISOString(),
      // EXPLICITLY NO MOCK FLAGS
      isReal: true
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    const responseTime = Date.now() - startTime
    console.error(`[${requestId}] REAL Jupiter API FAILED after ${responseTime}ms:`, error.message)
    
    // NEVER return mock data - fail with error instead
    return new Response(JSON.stringify({
      success: false,
      error: `Real Jupiter API failed: ${error.message}`,
      requestId,
      responseTime,
      source: 'REAL_JUPITER_API_FAILED',
      timestamp: new Date().toISOString(),
      // NO MOCK DATA FALLBACK
      isReal: false
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})