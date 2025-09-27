import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  console.log(`[${requestId}] Jupiter swap request started`);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const { quoteResponse, userPublicKey, wrapAndUnwrapSol = true, prioritizationFeeLamports = 1000000 } = await req.json();
    
    console.log(`[${requestId}] Creating Jupiter swap transaction:`, {
      userPublicKey,
      inputMint: quoteResponse.inputMint,
      outputMint: quoteResponse.outputMint,
      prioritizationFeeLamports
    });

    const jupiterResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports
      })
    });

    if (!jupiterResponse.ok) {
      throw new Error(`Jupiter swap API error: ${jupiterResponse.statusText}`);
    }

    const swapResult = await jupiterResponse.json();
    
    console.log(`[${requestId}] Jupiter swap transaction created successfully`);

    return new Response(JSON.stringify({
      success: true,
      data: swapResult,
      requestId
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error(`[${requestId}] Jupiter swap error:`, error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      requestId
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});