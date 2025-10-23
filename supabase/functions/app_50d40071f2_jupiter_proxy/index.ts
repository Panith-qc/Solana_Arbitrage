const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
  'Access-Control-Max-Age': '86400',
};

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID().substring(0, 8);
  console.log(`[${requestId}] Jupiter Proxy Request: ${req.method}`);
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    let targetUrl;
    
    if (req.method === 'POST') {
      const body = await req.json().catch(() => null);
      console.log(`[${requestId}] POST body:`, body);
      
      if (!body || !body.url) {
        return new Response(
          JSON.stringify({ error: 'Missing url in request body' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      targetUrl = body.url;
    } else {
      const url = new URL(req.url);
      targetUrl = url.searchParams.get('url');
      
      if (!targetUrl) {
        return new Response(
          JSON.stringify({ error: 'Missing url parameter' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    console.log(`[${requestId}] Original URL: ${targetUrl}`);

    // Use the correct Jupiter public API endpoints
    if (targetUrl.includes('price.jup.ag') || targetUrl.includes('api.jup.ag')) {
      // Extract token ID from the original URL
      const tokenMatch = targetUrl.match(/ids=([^&]+)/);
      if (tokenMatch) {
        const tokenIds = tokenMatch[1];
        // Use Jupiter's public price API - no auth required
        targetUrl = `https://price.jup.ag/v4/price?ids=${tokenIds}`;
        console.log(`[${requestId}] Using Jupiter public API: ${targetUrl}`);
      }
    }

    // Make the request to Jupiter's public API
    console.log(`[${requestId}] Fetching from: ${targetUrl}`);
    
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; Jupiter-Proxy/1.0)',
      },
    });

    console.log(`[${requestId}] Response status: ${response.status}`);

    if (!response.ok) {
      console.error(`[${requestId}] API error: ${response.status} ${response.statusText}`);
      const errorText = await response.text();
      console.error(`[${requestId}] Error details: ${errorText}`);
      
      throw new Error(`Jupiter API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`[${requestId}] Real Jupiter data:`, JSON.stringify(data).substring(0, 300));

    // Return the real Jupiter data
    return new Response(
      JSON.stringify(data),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error(`[${requestId}] Error:`, error.message);
    
    return new Response(
      JSON.stringify({
        error: 'Jupiter API request failed',
        message: error.message,
        requestId,
        timestamp: new Date().toISOString()
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});