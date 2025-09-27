import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  console.log(`[${requestId}] Jupiter quote request started`);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { inputMint, outputMint, amount, slippageBps = 100 } = body;
    
    console.log(`[${requestId}] Request body:`, body);
    console.log(`[${requestId}] Getting Jupiter quote:`, {
      inputMint,
      outputMint,
      amount,
      slippageBps,
      amountType: typeof amount
    });

    // Validate inputs
    if (!inputMint || !outputMint || amount === undefined || amount === null) {
      console.error(`[${requestId}] Missing required parameters:`, { inputMint, outputMint, amount });
      throw new Error('Missing required parameters: inputMint, outputMint, amount');
    }

    // Ensure amount is a valid number
    const cleanAmount = Math.floor(Number(amount));
    if (isNaN(cleanAmount) || cleanAmount <= 0) {
      console.error(`[${requestId}] Invalid amount:`, { originalAmount: amount, cleanAmount });
      throw new Error(`Invalid amount: ${amount}`);
    }

    const params = new URLSearchParams({
      inputMint: inputMint.toString(),
      outputMint: outputMint.toString(),
      amount: cleanAmount.toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'false'
    });

    console.log(`[${requestId}] Jupiter API URL: https://quote-api.jup.ag/v6/quote?${params.toString()}`);

    const jupiterResponse = await fetch(`https://quote-api.jup.ag/v6/quote?${params}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Supabase-Edge-Function/1.0'
      }
    });

    console.log(`[${requestId}] Jupiter response status: ${jupiterResponse.status}`);

    if (!jupiterResponse.ok) {
      const errorText = await jupiterResponse.text();
      console.error(`[${requestId}] Jupiter API error: ${jupiterResponse.status} ${jupiterResponse.statusText}`);
      console.error(`[${requestId}] Jupiter error response:`, errorText);
      throw new Error(`Jupiter API error: ${jupiterResponse.status} ${jupiterResponse.statusText} - ${errorText}`);
    }

    const quote = await jupiterResponse.json();
    
    console.log(`[${requestId}] Jupiter quote success:`, {
      inputAmount: quote.inAmount,
      outputAmount: quote.outAmount,
      priceImpact: quote.priceImpactPct
    });

    return new Response(JSON.stringify({
      success: true,
      data: quote,
      requestId
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error(`[${requestId}] Jupiter quote error:`, error);
    console.error(`[${requestId}] Error stack:`, error.stack);
    
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      requestId,
      stack: error.stack
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});