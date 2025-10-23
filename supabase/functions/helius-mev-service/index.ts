import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const HELIUS_RPC = Deno.env.get('HELIUS_RPC_URL') || 'https://mainnet.helius-rpc.com/?api-key=f84c0f8a-4329-40f0-8601-3fd422d718c3'
const HELIUS_API = Deno.env.get('HELIUS_API_URL') || 'https://api.helius.xyz/v0/transactions/?api-key=f84c0f8a-4329-40f0-8601-3fd422d718c3'

// NEW JUPITER ULTRA API ENDPOINTS
const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/ultra/v1/quote'
const JUPITER_SWAP_URL = 'https://lite-api.jup.ag/ultra/v1/swap'
const JUPITER_ORDER_URL = 'https://lite-api.jup.ag/ultra/v1/order'

serve(async (req) => {
  const requestId = crypto.randomUUID()
  const startTime = Date.now()
  console.log(`[${requestId}] Helius MEV Service with NEW Jupiter Ultra API - ${new Date().toISOString()}`)

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const { action, ...params } = body
    
    console.log(`[${requestId}] Action: ${action}`, params)

    let result
    switch(action) {
      case 'getQuote':
        result = await getJupiterQuote(params, requestId)
        break
      case 'executeSwap':
        result = await executeJupiterSwap(params, requestId)
        break
      case 'createOrder':
        result = await createJupiterOrder(params, requestId)
        break
      case 'getBalance':
        result = await getWalletBalance(params, requestId)
        break
      case 'getOpportunities':
        result = await getMEVOpportunities(params, requestId)
        break
      case 'parseTransaction':
        result = await parseTransaction(params, requestId)
        break
      default:
        throw new Error(`Invalid action: ${action}`)
    }

    const responseTime = Date.now() - startTime
    console.log(`[${requestId}] Success in ${responseTime}ms`)

    return new Response(JSON.stringify({
      success: true,
      data: result,
      requestId,
      responseTime,
      timestamp: new Date().toISOString(),
      isMock: false, // ALWAYS FALSE - REAL DATA ONLY
      source: 'JUPITER_ULTRA_API_VIA_HELIUS'
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    const responseTime = Date.now() - startTime
    console.error(`[${requestId}] Error after ${responseTime}ms:`, error.message)
    
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      requestId,
      responseTime,
      timestamp: new Date().toISOString(),
      isMock: false // NO MOCK DATA EVEN ON ERROR
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})

async function getJupiterQuote({ inputMint, outputMint, amount, slippageBps = 50 }, requestId: string) {
  console.log(`[${requestId}] Getting REAL Jupiter quote via NEW Ultra API`)
  
  // Use NEW Jupiter Ultra API - REAL DATA ONLY
  const jupiterUrl = `${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`
  
  console.log(`[${requestId}] NEW Jupiter Ultra API call: ${jupiterUrl}`)
  
  const response = await fetch(jupiterUrl, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Helius-MEV-Bot/1.0'
    },
    signal: AbortSignal.timeout(30000)
  })

  if (!response.ok) {
    throw new Error(`Jupiter Ultra API failed: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()
  
  // Validate real Jupiter Ultra data
  if (!data.inAmount || !data.outAmount) {
    throw new Error('Invalid Jupiter Ultra quote data received')
  }

  console.log(`[${requestId}] REAL Jupiter Ultra quote: ${data.inAmount} -> ${data.outAmount}`)
  
  return data
}

async function executeJupiterSwap({ quoteResponse, userPublicKey, prioritizationFeeLamports = 1000 }, requestId: string) {
  console.log(`[${requestId}] Executing REAL Jupiter swap via NEW Ultra API`)
  
  if (!quoteResponse || !userPublicKey) {
    throw new Error('Missing required parameters: quoteResponse and userPublicKey')
  }

  // Use NEW Jupiter Ultra Swap API - REAL TRANSACTION BUILDING
  const swapResponse = await fetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports
    }),
    signal: AbortSignal.timeout(30000)
  })

  if (!swapResponse.ok) {
    throw new Error(`Jupiter Ultra Swap API failed: ${swapResponse.status} ${swapResponse.statusText}`)
  }

  const swapData = await swapResponse.json()
  
  if (!swapData.swapTransaction) {
    throw new Error('Invalid swap transaction data received from Jupiter Ultra API')
  }

  console.log(`[${requestId}] REAL Jupiter Ultra swap transaction created`)
  
  return swapData
}

async function createJupiterOrder({ inputMint, outputMint, inAmount, outAmount, userPublicKey }, requestId: string) {
  console.log(`[${requestId}] Creating REAL Jupiter order via NEW Ultra API`)
  
  if (!inputMint || !outputMint || !inAmount || !outAmount || !userPublicKey) {
    throw new Error('Missing required parameters for Jupiter order')
  }

  // Use NEW Jupiter Ultra Order API
  const orderResponse = await fetch(JUPITER_ORDER_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      inputMint,
      outputMint,
      inAmount,
      outAmount,
      userPublicKey
    }),
    signal: AbortSignal.timeout(30000)
  })

  if (!orderResponse.ok) {
    throw new Error(`Jupiter Ultra Order API failed: ${orderResponse.status} ${orderResponse.statusText}`)
  }

  const orderData = await orderResponse.json()
  
  console.log(`[${requestId}] REAL Jupiter Ultra order created`)
  
  return orderData
}

async function getWalletBalance({ walletAddress }, requestId: string) {
  console.log(`[${requestId}] Getting REAL wallet balance via Helius RPC`)
  
  if (!walletAddress) {
    throw new Error('Missing walletAddress parameter')
  }

  // Use Helius RPC for REAL balance - NO MOCK DATA
  const response = await fetch(HELIUS_RPC, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [walletAddress]
    }),
    signal: AbortSignal.timeout(15000)
  })

  if (!response.ok) {
    throw new Error(`Helius RPC failed: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()
  
  if (data.error) {
    throw new Error(`Helius RPC error: ${data.error.message}`)
  }

  console.log(`[${requestId}] REAL balance: ${data.result.value} lamports`)
  
  return {
    balance: data.result.value,
    context: data.result.context
  }
}

async function getMEVOpportunities(params: any, requestId: string) {
  console.log(`[${requestId}] Scanning for REAL MEV opportunities via NEW Jupiter Ultra API`)
  
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
      amount: '500000000' // 0.5 SOL
    }
  ]

  // Get REAL quotes for arbitrage detection using NEW Jupiter Ultra API
  for (const pair of tradingPairs) {
    try {
      console.log(`[${requestId}] Getting REAL quote for ${pair.symbol} arbitrage via Jupiter Ultra`)
      
      const quoteData = await getJupiterQuote({
        inputMint: pair.inputMint,
        outputMint: pair.outputMint,
        amount: pair.amount,
        slippageBps: 50
      }, requestId)
      
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
          source: 'REAL_JUPITER_ULTRA_VIA_HELIUS'
        }
        
        opportunities.push(opportunity)
        console.log(`[${requestId}] REAL MEV opportunity found via Jupiter Ultra: ${pair.symbol} with ${priceImpact}% impact`)
      }

    } catch (error) {
      console.warn(`[${requestId}] Failed to analyze ${pair.symbol} for REAL opportunities via Jupiter Ultra:`, error.message)
    }
  }

  console.log(`[${requestId}] REAL MEV scan completed via Jupiter Ultra - found ${opportunities.length} opportunities`)
  
  return {
    opportunities,
    count: opportunities.length,
    source: 'REAL_JUPITER_ULTRA_VIA_HELIUS'
  }
}

async function parseTransaction({ signature }, requestId: string) {
  console.log(`[${requestId}] Parsing REAL transaction via Helius API`)
  
  if (!signature) {
    throw new Error('Missing signature parameter')
  }

  // Use Helius Transaction API for REAL transaction parsing
  const url = HELIUS_API.replace('?', `${signature}?`)
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(15000)
  })

  if (!response.ok) {
    throw new Error(`Helius Transaction API failed: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()
  
  console.log(`[${requestId}] REAL transaction parsed: ${signature}`)
  
  return data
}