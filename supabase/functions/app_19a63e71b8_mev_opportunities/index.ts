import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

serve(async (req) => {
  const requestId = crypto.randomUUID()
  console.log(`[${requestId}] MEV Opportunities ${req.method}`)

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    // Initialize Supabase client for data storage
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Real MEV opportunity detection logic
    const opportunities = []
    
    // Get current market data from Jupiter
    const JUPITER_BASE = 'https://quote-api.jup.ag'
    
    // Common trading pairs for MEV opportunities
    const tradingPairs = [
      {
        inputMint: 'So11111111111111111111111111111111111111112', // SOL
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        symbol: 'SOL/USDC'
      },
      {
        inputMint: 'So11111111111111111111111111111111111111112', // SOL
        outputMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
        symbol: 'SOL/USDT'
      }
    ]

    // Check each pair for arbitrage opportunities
    for (const pair of tradingPairs) {
      try {
        // Get quote for 1 SOL
        const amount = '1000000000' // 1 SOL in lamports
        const quoteUrl = `${JUPITER_BASE}/v6/quote?inputMint=${pair.inputMint}&outputMint=${pair.outputMint}&amount=${amount}&slippageBps=50`
        
        const response = await fetch(quoteUrl, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'MEV-Scanner/1.0'
          }
        })

        if (response.ok) {
          const quoteData = await response.json()
          
          // Calculate potential profit (simplified MEV detection)
          const inputAmount = parseInt(quoteData.inAmount)
          const outputAmount = parseInt(quoteData.outAmount)
          const priceImpact = parseFloat(quoteData.priceImpactPct || '0')
          
          // Look for opportunities with low price impact and good liquidity
          if (priceImpact < 0.5 && outputAmount > 0) {
            opportunities.push({
              id: `${pair.symbol}-${Date.now()}`,
              type: 'arbitrage',
              pair: pair.symbol,
              inputMint: pair.inputMint,
              outputMint: pair.outputMint,
              inputAmount,
              outputAmount,
              priceImpact,
              profitEstimate: Math.abs(priceImpact * inputAmount * 0.01), // Rough estimate
              confidence: priceImpact < 0.1 ? 'high' : 'medium',
              timestamp: new Date().toISOString(),
              routePlan: quoteData.routePlan
            })
          }
        }
      } catch (error) {
        console.warn(`[${requestId}] Failed to check ${pair.symbol}:`, error.message)
      }
    }

    // Store opportunities in database
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
        console.warn(`[${requestId}] Failed to store opportunities:`, insertError.message)
      }
    }

    console.log(`[${requestId}] Found ${opportunities.length} MEV opportunities`)

    return new Response(JSON.stringify({
      success: true,
      opportunities,
      count: opportunities.length,
      requestId,
      timestamp: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error(`[${requestId}] Error:`, error.message)
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      opportunities: [],
      requestId
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})