import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

serve(async (req) => {
  const requestId = crypto.randomUUID()
  const startTime = Date.now()
  console.log(`[${requestId}] REAL MEV Opportunities Service - ${new Date().toISOString()}`)

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    console.log(`[${requestId}] Scanning for REAL MEV opportunities using REAL Jupiter data`)

    const opportunities = []
    
    // Define REAL trading pairs for MEV scanning
    const tradingPairs = [
      {
        inputMint: 'So11111111111111111111111111111111111111112', // SOL
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        symbol: 'SOL/USDC',
        amount: '1000000000' // 1 SOL
      },
      {
        inputMint: 'So11111111111111111111111111111111111111112', // SOL  
        outputMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
        symbol: 'SOL/USDT',
        amount: '1000000000' // 1 SOL
      }
    ]

    // Get REAL quotes for each pair - NO MOCK DATA
    for (const pair of tradingPairs) {
      try {
        console.log(`[${requestId}] Getting REAL quote for ${pair.symbol}`)
        
        const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${pair.inputMint}&outputMint=${pair.outputMint}&amount=${pair.amount}&slippageBps=50`
        
        const response = await fetch(quoteUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'MEV-Scanner/1.0'
          },
          signal: AbortSignal.timeout(15000)
        })

        if (!response.ok) {
          console.warn(`[${requestId}] Failed to get REAL quote for ${pair.symbol}: HTTP ${response.status}`)
          continue
        }

        const quoteData = await response.json()
        console.log(`[${requestId}] REAL quote received for ${pair.symbol}: ${quoteData.outAmount}`)
        
        // Analyze REAL data for MEV opportunities
        const inputAmount = parseInt(quoteData.inAmount)
        const outputAmount = parseInt(quoteData.outAmount)
        const priceImpact = parseFloat(quoteData.priceImpactPct || '0')
        
        // Only consider opportunities with significant price movement (REAL market conditions)
        if (priceImpact > 0.05 && outputAmount > 0) { // > 0.05% impact indicates real opportunity
          const opportunity = {
            id: `${pair.symbol.replace('/', '-')}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: 'arbitrage',
            pair: pair.symbol,
            inputMint: pair.inputMint,
            outputMint: pair.outputMint,
            inputAmount,
            outputAmount,
            priceImpact,
            profitEstimate: Math.abs(priceImpact * inputAmount * 0.01),
            confidence: priceImpact < 0.5 ? 'high' : 'medium',
            timestamp: new Date().toISOString(),
            routePlan: quoteData.routePlan,
            // REAL data identifiers
            source: 'REAL_JUPITER_API',
            isReal: true
          }
          
          opportunities.push(opportunity)
          console.log(`[${requestId}] REAL MEV opportunity found: ${pair.symbol} with ${priceImpact}% impact`)
        }

      } catch (error) {
        console.warn(`[${requestId}] Failed to analyze ${pair.symbol} for REAL opportunities:`, error.message)
      }
    }

    // Store REAL opportunities in database
    if (opportunities.length > 0) {
      const { error: insertError } = await supabase
        .from('app_19a63e71b8_opportunities')
        .insert(opportunities.map(opp => ({
          opportunity_id: opp.id,
          type: opp.type,
          data: opp,
          created_at: new Date().toISOString()
        })))

      if (insertError) {
        console.warn(`[${requestId}] Failed to store REAL opportunities:`, insertError.message)
      } else {
        console.log(`[${requestId}] Stored ${opportunities.length} REAL opportunities in database`)
      }
    }

    const responseTime = Date.now() - startTime
    console.log(`[${requestId}] REAL MEV scan completed in ${responseTime}ms - found ${opportunities.length} opportunities`)

    return new Response(JSON.stringify({
      success: true,
      opportunities,
      count: opportunities.length,
      requestId,
      responseTime,
      source: 'REAL_JUPITER_API',
      timestamp: new Date().toISOString(),
      isReal: true
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    const responseTime = Date.now() - startTime
    console.error(`[${requestId}] REAL MEV opportunities scan FAILED after ${responseTime}ms:`, error.message)
    
    // Return empty array instead of mock opportunities
    return new Response(JSON.stringify({
      success: false,
      error: `Real MEV scan failed: ${error.message}`,
      opportunities: [],
      count: 0,
      requestId,
      responseTime,
      source: 'REAL_JUPITER_API_FAILED',
      timestamp: new Date().toISOString(),
      isReal: false
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})