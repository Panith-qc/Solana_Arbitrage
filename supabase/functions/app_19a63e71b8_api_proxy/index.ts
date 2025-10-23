const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-requested-with',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
  'Access-Control-Max-Age': '86400',
};

Deno.serve(async (req) => {
  console.log(`Request: ${req.method} ${req.url}`);
  
  // Handle CORS preflight requests FIRST
  if (req.method === 'OPTIONS') {
    console.log('Handling CORS preflight request');
    return new Response(null, { 
      status: 204, 
      headers: corsHeaders 
    });
  }

  try {
    const requestId = crypto.randomUUID();
    console.log(`[${requestId}] Processing ${req.method} request`);

    let body = {};
    
    // Parse request body for POST requests
    if (req.method === 'POST') {
      try {
        const text = await req.text();
        console.log(`[${requestId}] Request body: ${text}`);
        body = JSON.parse(text);
      } catch (e) {
        console.error(`[${requestId}] JSON parse error:`, e);
        return new Response(
          JSON.stringify({ success: false, error: 'Invalid JSON' }),
          { 
            status: 400, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          }
        );
      }
    }

    const { url, method = 'GET', headers = {} } = body;

    if (!url) {
      console.error(`[${requestId}] No URL provided`);
      return new Response(
        JSON.stringify({ success: false, error: 'URL required' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    console.log(`[${requestId}] Proxying to: ${url}`);

    // Make external request
    const response = await fetch(url, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Supabase-Edge)',
        'Accept': 'application/json',
        ...headers
      }
    });

    const data = await response.json();
    console.log(`[${requestId}] Response status: ${response.status}`);

    return new Response(
      JSON.stringify({
        success: true,
        data: data,
        status: response.status
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error('Edge function error:', error);
    
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});