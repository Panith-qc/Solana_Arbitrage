import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { quote, userPublicKey, priorityFee } = await req.json()
    
    // Validate required fields
    if (!quote || !userPublicKey) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: quote and userPublicKey' }),
        { 
          status: 400,
          headers: { 
            ...corsHeaders, 
            'Content-Type': 'application/json' 
          } 
        }
      )
    }

    // Call Jupiter swap API with correct field name
    const response = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        quoteResponse: quote,  // Changed from 'quote' to 'quoteResponse'
        userPublicKey,
        wrapAndUnwrapSol: true,  // Added for better SOL handling
        useSharedAccounts: true,  // Added for better efficiency
        feeAccount: undefined,
        trackingAccount: undefined,
        computeUnitPriceMicroLamports: priorityFee ? Math.floor(priorityFee / 1000000) : 200,
        prioritizationFeeLamports: priorityFee || 200000,
        asLegacyTransaction: false,
        useTokenLedger: false,
        destinationTokenAccount: undefined,
        dynamicComputeUnitLimit: true,
        skipUserAccountsRpcCalls: false
      })
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error(`Jupiter swap API error: ${response.status} - ${errorText}`)
      
      return new Response(
        JSON.stringify({ 
          error: `Jupiter swap API error: ${response.status}`,
          details: errorText 
        }),
        { 
          status: response.status,
          headers: { 
            ...corsHeaders, 
            'Content-Type': 'application/json' 
          } 
        }
      )
    }
    
    const data = await response.json()
    
    return new Response(
      JSON.stringify(data),
      { 
        headers: { 
          ...corsHeaders, 
          'Content-Type': 'application/json' 
        } 
      }
    )
  } catch (error) {
    console.error('Swap function error:', error)
    
    return new Response(
      JSON.stringify({ 
        error: error.message || 'Internal server error',
        stack: error.stack 
      }),
      { 
        status: 500,
        headers: { 
          ...corsHeaders, 
          'Content-Type': 'application/json' 
        } 
      }
    )
  }
})