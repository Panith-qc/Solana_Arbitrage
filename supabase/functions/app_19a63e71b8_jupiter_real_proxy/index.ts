import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

serve(async (req) => {
  const requestId = crypto.randomUUID()
  console.log(`[${requestId}] REAL Jupiter Proxy ${req.method}`)

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const { action, inputMint, outputMint, amount, slippageBps, quote, userPublicKey } = body

    // Use alternative Jupiter endpoints that might work
    const JUPITER_ENDPOINTS = [
      'https://quote-api.jup.ag',
      'https://jupiter-swap-api.quiknode.pro',
      'https://api.jup.ag'
    ]

    if (action === 'quote' || (!action && inputMint && outputMint && amount)) {
      let lastError = null
      
      // Try each Jupiter endpoint
      for (const baseUrl of JUPITER_ENDPOINTS) {
        try {
          const quoteUrl = `${baseUrl}/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps || 50}`
          
          console.log(`[${requestId}] Trying REAL Jupiter API: ${baseUrl}`)
          
          const response = await fetch(quoteUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'Solana-MEV-Bot/1.0',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            },
            signal: AbortSignal.timeout(10000) // 10 second timeout
          })

          if (response.ok) {
            const quoteData = await response.json()
            console.log(`[${requestId}] SUCCESS: Real Jupiter quote from ${baseUrl}`)
            
            return new Response(JSON.stringify({
              success: true,
              data: quoteData,
              requestId,
              source: baseUrl,
              isReal: true,
              timestamp: new Date().toISOString()
            }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            })
          } else {
            console.log(`[${requestId}] ${baseUrl} returned ${response.status}`)
          }
        } catch (error) {
          console.log(`[${requestId}] ${baseUrl} failed: ${error.message}`)
          lastError = error
        }
      }
      
      // If all endpoints fail, throw the last error
      throw new Error(`All Jupiter endpoints failed. Last error: ${lastError?.message}`)
    }

    if (action === 'swap' && quote && userPublicKey) {
      // Try swap endpoints
      for (const baseUrl of JUPITER_ENDPOINTS) {
        try {
          console.log(`[${requestId}] Trying REAL Jupiter swap: ${baseUrl}`)
          
          const swapResponse = await fetch(`${baseUrl}/v6/swap`, {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'User-Agent': 'Solana-MEV-Bot/1.0'
            },
            body: JSON.stringify({
              quoteResponse: quote,
              userPublicKey,
              wrapAndUnwrapSol: true,
              prioritizationFeeLamports: 1000
            }),
            signal: AbortSignal.timeout(15000)
          })

          if (swapResponse.ok) {
            const swapData = await swapResponse.json()
            console.log(`[${requestId}] SUCCESS: Real Jupiter swap from ${baseUrl}`)
            
            return new Response(JSON.stringify({
              success: true,
              data: swapData,
              requestId,
              source: baseUrl,
              isReal: true
            }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            })
          }
        } catch (error) {
          console.log(`[${requestId}] Swap ${baseUrl} failed: ${error.message}`)
        }
      }
      
      throw new Error('All Jupiter swap endpoints failed')
    }

    if (action === 'health') {
      // Test connectivity to real Jupiter API
      for (const baseUrl of JUPITER_ENDPOINTS) {
        try {
          const healthResponse = await fetch(`${baseUrl}/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000)
          })

          if (healthResponse.ok) {
            return new Response(JSON.stringify({
              success: true,
              status: healthResponse.status,
              requestId,
              workingEndpoint: baseUrl,
              isReal: true,
              message: "Real Jupiter API accessible"
            }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            })
          }
        } catch (error) {
          console.log(`[${requestId}] Health check ${baseUrl} failed: ${error.message}`)
        }
      }
      
      return new Response(JSON.stringify({
        success: false,
        requestId,
        message: "No Jupiter endpoints accessible",
        isReal: false
      }), {
        status: 503,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    throw new Error(`Invalid action: ${action}`)

  } catch (error) {
    console.error(`[${requestId}] REAL Jupiter Proxy Error:`, error.message)
    return new Response(JSON.stringify({
      success: false,
      error: `Real Jupiter API failed: ${error.message}`,
      requestId,
      isReal: false,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})