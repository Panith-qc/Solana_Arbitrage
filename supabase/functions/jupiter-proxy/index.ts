const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// Simple delay function for rate limiting
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  console.log(`🔄 [${requestId}] Jupiter Proxy Request: ${req.method}`);

  if (req.method === 'OPTIONS') {
    return new Response(null, { 
      status: 204, 
      headers: corsHeaders 
    });
  }

  try {
    // Add small delay to prevent rate limiting
    await delay(Math.random() * 100 + 50); // 50-150ms random delay
    
    let body;
    try {
      body = await req.json();
    } catch (e) {
      throw new Error('Invalid JSON in request body');
    }
    
    const { url } = body;
    
    if (!url) {
      throw new Error('URL parameter is required');
    }

    console.log(`🌐 [${requestId}] Fetching real Jupiter API: ${url}`);

    // Make actual request to Jupiter API with proper headers
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'MEV-Bot/1.0',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(`Jupiter API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    console.log(`✅ [${requestId}] Jupiter API success: ${JSON.stringify(data).length} bytes`);
    
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error(`❌ [${requestId}] Error:`, error.message);
    
    return new Response(JSON.stringify({
      error: 'Jupiter API request failed',
      message: error.message,
      timestamp: new Date().toISOString(),
      requestId,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});