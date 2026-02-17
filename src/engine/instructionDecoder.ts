// DEX SWAP INSTRUCTION DECODER
// Decodes raw Solana transaction instructions to extract swap parameters
// from Raydium AMM, Orca Whirlpool, and Jupiter Aggregator programs.
// Used by MEV strategies to evaluate pending swaps for sandwich/backrun profitability.

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { dataLog } from './logger.js';
import { LAMPORTS_PER_SOL } from './config.js';

// ═══════════════════════════════════════════════════════════════
// DEX Program IDs
// ═══════════════════════════════════════════════════════════════

const RAYDIUM_AMM_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const ORCA_WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const JUPITER_AGGREGATOR_PROGRAM = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');

// ═══════════════════════════════════════════════════════════════
// Instruction Discriminators
// ═══════════════════════════════════════════════════════════════

/**
 * Raydium AMM V4 uses a simple u8 discriminator at data[0].
 * Value 9 = swapBaseIn, value 11 = swapBaseOut.
 */
const RAYDIUM_SWAP_IN_DISCRIMINATOR = 9;
const RAYDIUM_SWAP_OUT_DISCRIMINATOR = 11;

/**
 * Orca Whirlpool uses Anchor-style 8-byte discriminators.
 * "swap" discriminator = SHA-256("global:swap")[0..8]
 */
const ORCA_SWAP_DISCRIMINATOR = Buffer.from([0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]);

/**
 * Jupiter Aggregator v6 "route" discriminator.
 * SHA-256("global:route")[0..8]
 */
const JUPITER_ROUTE_DISCRIMINATOR = Buffer.from([0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a]);

/**
 * Jupiter "sharedAccountsRoute" discriminator (alternative routing path).
 */
const JUPITER_SHARED_ROUTE_DISCRIMINATOR = Buffer.from([0xc1, 0x20, 0x9b, 0x33, 0x41, 0xd6, 0x9c, 0x81]);

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** Supported DEX identifiers */
export type DexName = 'raydium' | 'orca' | 'jupiter' | 'unknown';

/** Decoded swap details from a DEX instruction */
export interface SwapDetails {
  /** Which DEX the swap belongs to */
  dex: DexName;
  /** Pool or AMM account address */
  poolAddress: string;
  /** Token being sold */
  tokenIn: string;
  /** Token being bought */
  tokenOut: string;
  /** Amount of tokenIn being swapped (raw u64) */
  amountIn: bigint;
  /** Minimum acceptable output amount (slippage protection) */
  minAmountOut: bigint;
  /** User wallet initiating the swap */
  userAccount: string;
}

/** Estimated price impact of a swap on pool reserves */
export interface SwapImpact {
  /** Price impact as a decimal (0.01 = 1%) */
  priceImpact: number;
  /** Estimated output amount based on constant-product AMM */
  estimatedOutput: bigint;
  /** Effective price (tokenOut per tokenIn) after the swap */
  effectivePrice: number;
  /** Spot price before the swap */
  spotPriceBefore: number;
  /** Spot price after the swap */
  spotPriceAfter: number;
}

/** Pool reserves used for impact estimation */
export interface PoolReserves {
  reserveIn: bigint;
  reserveOut: bigint;
  /** Fee in basis points (e.g. 25 = 0.25%) */
  feeBps: number;
}

/** Result of sandwich profitability check */
export interface SandwichAnalysis {
  /** Whether the swap is a viable sandwich target */
  isTargetable: boolean;
  /** Estimated profit in lamports */
  estimatedProfitLamports: bigint;
  /** Estimated profit in USD */
  estimatedProfitUsd: number;
  /** Optimal front-run amount in lamports */
  optimalFrontrunAmount: bigint;
  /** Reason for rejection (if not targetable) */
  reason: string;
}

// ═══════════════════════════════════════════════════════════════
// Core decoder functions
// ═══════════════════════════════════════════════════════════════

/**
 * Check whether a transaction instruction is a known DEX swap.
 */
export function isSwapInstruction(instruction: TransactionInstruction): boolean {
  const programId = instruction.programId.toString();

  if (programId === RAYDIUM_AMM_PROGRAM.toString()) {
    return isRaydiumSwap(instruction.data);
  }

  if (programId === ORCA_WHIRLPOOL_PROGRAM.toString()) {
    return isOrcaSwap(instruction.data);
  }

  if (programId === JUPITER_AGGREGATOR_PROGRAM.toString()) {
    return isJupiterRoute(instruction.data);
  }

  return false;
}

/**
 * Detect the DEX and decode swap parameters from a raw instruction.
 * Returns null if the instruction is not a recognized swap.
 */
export function decodeSwapInstruction(
  instruction: TransactionInstruction
): SwapDetails | null {
  const programId = instruction.programId.toString();

  try {
    if (programId === RAYDIUM_AMM_PROGRAM.toString()) {
      return decodeRaydiumSwap(instruction);
    }

    if (programId === ORCA_WHIRLPOOL_PROGRAM.toString()) {
      return decodeOrcaSwap(instruction);
    }

    if (programId === JUPITER_AGGREGATOR_PROGRAM.toString()) {
      return decodeJupiterRoute(instruction);
    }
  } catch (err) {
    dataLog.error(
      { err, programId },
      'Failed to decode swap instruction'
    );
  }

  return null;
}

/**
 * Convenience wrapper: detect and decode in one call.
 * Returns full SwapDetails or null.
 */
export function getSwapDetails(
  instruction: TransactionInstruction
): SwapDetails | null {
  if (!isSwapInstruction(instruction)) return null;
  return decodeSwapInstruction(instruction);
}

// ═══════════════════════════════════════════════════════════════
// Price impact estimation
// ═══════════════════════════════════════════════════════════════

/**
 * Estimate the price impact of a swap on a constant-product AMM pool.
 * Uses the x * y = k formula with fee deduction.
 */
export function estimateSwapImpact(
  details: SwapDetails,
  poolReserves: PoolReserves
): SwapImpact {
  const { reserveIn, reserveOut, feeBps } = poolReserves;
  const amountIn = details.amountIn;

  // Deduct fee from input
  const feeMultiplier = 10000n - BigInt(feeBps);
  const amountInAfterFee = (amountIn * feeMultiplier) / 10000n;

  // Constant-product formula: dy = (y * dx) / (x + dx)
  const numerator = reserveOut * amountInAfterFee;
  const denominator = reserveIn + amountInAfterFee;
  const estimatedOutput = denominator > 0n ? numerator / denominator : 0n;

  // Prices
  const reserveInNum = Number(reserveIn);
  const reserveOutNum = Number(reserveOut);
  const amountInNum = Number(amountInAfterFee);

  const spotPriceBefore = reserveInNum > 0 ? reserveOutNum / reserveInNum : 0;

  // New reserves after swap
  const newReserveIn = reserveInNum + amountInNum;
  const newReserveOut = reserveOutNum - Number(estimatedOutput);
  const spotPriceAfter = newReserveIn > 0 ? newReserveOut / newReserveIn : 0;

  // Price impact
  const effectivePrice = amountInNum > 0 ? Number(estimatedOutput) / amountInNum : 0;
  const priceImpact = spotPriceBefore > 0
    ? Math.abs(spotPriceBefore - spotPriceAfter) / spotPriceBefore
    : 0;

  return {
    priceImpact,
    estimatedOutput,
    effectivePrice,
    spotPriceBefore,
    spotPriceAfter,
  };
}

// ═══════════════════════════════════════════════════════════════
// Sandwich profitability analysis
// ═══════════════════════════════════════════════════════════════

/**
 * Determine whether a pending swap is large enough to sandwich profitably.
 *
 * The analysis:
 * 1. Estimates the price impact of the victim swap.
 * 2. Calculates the optimal front-run size (~50% of victim for typical pools).
 * 3. Estimates profit after gas + Jito tip costs.
 * 4. Returns true only if estimated profit exceeds minProfitUsd.
 */
export function isTargetableForSandwich(
  details: SwapDetails,
  minProfitUsd: number,
  poolReserves?: PoolReserves,
  solPriceUsd: number = 150
): SandwichAnalysis {
  const defaultResult: SandwichAnalysis = {
    isTargetable: false,
    estimatedProfitLamports: 0n,
    estimatedProfitUsd: 0,
    optimalFrontrunAmount: 0n,
    reason: '',
  };

  // Minimum viable swap size: 0.01 SOL equivalent
  const MIN_SWAP_LAMPORTS = BigInt(LAMPORTS_PER_SOL) / 100n;

  if (details.amountIn < MIN_SWAP_LAMPORTS) {
    return { ...defaultResult, reason: 'Swap amount too small' };
  }

  // If no pool reserves provided, do a heuristic check based on amount alone
  if (!poolReserves) {
    const amountInSol = Number(details.amountIn) / LAMPORTS_PER_SOL;
    const amountInUsd = amountInSol * solPriceUsd;

    // Rough heuristic: sandwich profit is ~0.1-0.5% of swap size for large swaps
    const estimatedProfitUsd = amountInUsd * 0.002;

    if (estimatedProfitUsd < minProfitUsd) {
      return {
        ...defaultResult,
        reason: `Heuristic profit $${estimatedProfitUsd.toFixed(4)} below min $${minProfitUsd}`,
      };
    }

    return {
      isTargetable: true,
      estimatedProfitLamports: BigInt(Math.floor(estimatedProfitUsd / solPriceUsd * LAMPORTS_PER_SOL)),
      estimatedProfitUsd,
      optimalFrontrunAmount: details.amountIn / 2n,
      reason: 'Heuristic analysis (no pool reserves)',
    };
  }

  // Full analysis with pool reserves
  const { reserveIn, reserveOut, feeBps } = poolReserves;

  // Check pool liquidity - skip illiquid pools
  if (reserveIn === 0n || reserveOut === 0n) {
    return { ...defaultResult, reason: 'Pool has zero reserves' };
  }

  // Estimate victim swap impact
  const victimImpact = estimateSwapImpact(details, poolReserves);

  if (victimImpact.priceImpact < 0.001) {
    return { ...defaultResult, reason: 'Victim price impact too low (<0.1%)' };
  }

  // Optimal front-run amount: approximately sqrt(k * fee_adjustment) relationship,
  // simplified to ~40-60% of victim size depending on pool depth
  const poolDepthRatio = Number(details.amountIn) / Number(reserveIn);
  const frontrunRatio = Math.min(0.6, Math.max(0.2, poolDepthRatio * 5));
  const optimalFrontrunAmount = BigInt(
    Math.floor(Number(details.amountIn) * frontrunRatio)
  );

  // Simulate front-run swap
  const frontrunDetails: SwapDetails = {
    ...details,
    amountIn: optimalFrontrunAmount,
    minAmountOut: 0n,
  };
  const frontrunImpact = estimateSwapImpact(frontrunDetails, poolReserves);

  // New reserves after front-run
  const reserveInAfterFrontrun = reserveIn + optimalFrontrunAmount;
  const reserveOutAfterFrontrun = reserveOut - frontrunImpact.estimatedOutput;

  // Simulate victim swap on moved pool
  const victimOnMovedPool = estimateSwapImpact(details, {
    reserveIn: reserveInAfterFrontrun,
    reserveOut: reserveOutAfterFrontrun,
    feeBps,
  });

  // After victim swaps, back-run: sell the tokens we bought in front-run
  const reserveInAfterVictim = reserveInAfterFrontrun + details.amountIn;
  const reserveOutAfterVictim = reserveOutAfterFrontrun - victimOnMovedPool.estimatedOutput;

  // Back-run: sell tokenOut for tokenIn
  const backrunAmountIn = frontrunImpact.estimatedOutput;
  const feeMultiplier = 10000n - BigInt(feeBps);
  const backrunAfterFee = (backrunAmountIn * feeMultiplier) / 10000n;

  // Note: in back-run we're selling tokenOut for tokenIn, so reserves are flipped
  const backrunOutput =
    reserveInAfterVictim > 0n
      ? (reserveInAfterVictim * backrunAfterFee) /
        (reserveOutAfterVictim + backrunAfterFee)
      : 0n;

  // Profit = backrun output - frontrun input
  const rawProfit = backrunOutput > optimalFrontrunAmount
    ? backrunOutput - optimalFrontrunAmount
    : 0n;

  // Deduct estimated costs: ~5000 lamports gas + 100000 lamports Jito tip
  const estimatedCostLamports = 105000n;
  const netProfitLamports = rawProfit > estimatedCostLamports
    ? rawProfit - estimatedCostLamports
    : 0n;

  const netProfitSol = Number(netProfitLamports) / LAMPORTS_PER_SOL;
  const netProfitUsd = netProfitSol * solPriceUsd;

  if (netProfitUsd < minProfitUsd) {
    return {
      ...defaultResult,
      estimatedProfitLamports: netProfitLamports,
      estimatedProfitUsd: netProfitUsd,
      optimalFrontrunAmount,
      reason: `Net profit $${netProfitUsd.toFixed(4)} below min $${minProfitUsd}`,
    };
  }

  return {
    isTargetable: true,
    estimatedProfitLamports: netProfitLamports,
    estimatedProfitUsd: netProfitUsd,
    optimalFrontrunAmount,
    reason: 'Profitable sandwich opportunity',
  };
}

// ═══════════════════════════════════════════════════════════════
// Raydium AMM V4 decoder
// ═══════════════════════════════════════════════════════════════

function isRaydiumSwap(data: Buffer): boolean {
  if (data.length < 1) return false;
  return data[0] === RAYDIUM_SWAP_IN_DISCRIMINATOR ||
         data[0] === RAYDIUM_SWAP_OUT_DISCRIMINATOR;
}

/**
 * Raydium AMM V4 swap instruction layout:
 *   [0]     u8   instruction discriminator (9 = swapBaseIn, 11 = swapBaseOut)
 *   [1..9]  u64  amountIn
 *   [9..17] u64  minAmountOut
 *
 * Account indices (swapBaseIn):
 *   0: token program
 *   1: amm id (pool)
 *   2: amm authority
 *   3: amm open orders
 *   4: amm target orders (or pool coin token account)
 *   5: pool coin token account
 *   6: pool pc token account
 *   7: serum program
 *   8: serum market
 *   9: serum bids
 *  10: serum asks
 *  11: serum event queue
 *  12: serum coin vault
 *  13: serum pc vault
 *  14: serum vault signer
 *  15: user source token account
 *  16: user destination token account
 *  17: user wallet (signer)
 */
function decodeRaydiumSwap(instruction: TransactionInstruction): SwapDetails | null {
  const data = instruction.data;

  if (!isRaydiumSwap(data)) return null;
  if (data.length < 17) {
    dataLog.debug({ dataLen: data.length }, 'Raydium swap data too short');
    return null;
  }

  const amountIn = data.readBigUInt64LE(1);
  const minAmountOut = data.readBigUInt64LE(9);

  const keys = instruction.keys;

  // Need at least 18 accounts for a full Raydium swap
  if (keys.length < 18) {
    dataLog.debug(
      { keyCount: keys.length },
      'Raydium swap has fewer accounts than expected'
    );
    // Try to extract what we can
    return {
      dex: 'raydium',
      poolAddress: keys.length > 1 ? keys[1].pubkey.toString() : '',
      tokenIn: keys.length > 15 ? keys[15].pubkey.toString() : '',
      tokenOut: keys.length > 16 ? keys[16].pubkey.toString() : '',
      amountIn,
      minAmountOut,
      userAccount: keys.length > 17 ? keys[17].pubkey.toString() : '',
    };
  }

  return {
    dex: 'raydium',
    poolAddress: keys[1].pubkey.toString(),  // AMM ID
    tokenIn: keys[15].pubkey.toString(),     // User source token account
    tokenOut: keys[16].pubkey.toString(),    // User destination token account
    amountIn,
    minAmountOut,
    userAccount: keys[17].pubkey.toString(), // User wallet (signer)
  };
}

// ═══════════════════════════════════════════════════════════════
// Orca Whirlpool decoder
// ═══════════════════════════════════════════════════════════════

function isOrcaSwap(data: Buffer): boolean {
  if (data.length < 8) return false;
  return data.subarray(0, 8).equals(ORCA_SWAP_DISCRIMINATOR);
}

/**
 * Orca Whirlpool swap instruction layout (Anchor):
 *   [0..8]   8-byte discriminator ("swap")
 *   [8..16]  u64  amount
 *   [16..24] u64  otherAmountThreshold (minAmountOut or maxAmountIn)
 *   [24..40] u128 sqrtPriceLimit
 *   [40]     bool amountSpecifiedIsInput
 *   [41]     bool aToB (direction)
 *
 * Account indices:
 *   0: token program
 *   1: token authority (user wallet signer)
 *   2: whirlpool
 *   3: token owner account A
 *   4: token vault A
 *   5: token owner account B
 *   6: token vault B
 *   7: tick array 0
 *   8: tick array 1
 *   9: tick array 2
 *  10: oracle
 */
function decodeOrcaSwap(instruction: TransactionInstruction): SwapDetails | null {
  const data = instruction.data;

  if (!isOrcaSwap(data)) return null;
  if (data.length < 42) {
    dataLog.debug({ dataLen: data.length }, 'Orca swap data too short');
    return null;
  }

  const amount = data.readBigUInt64LE(8);
  const otherAmountThreshold = data.readBigUInt64LE(16);
  // sqrtPriceLimit is at [24..40] - u128, skip for now
  const amountSpecifiedIsInput = data[40] === 1;
  const aToB = data[41] === 1;

  const keys = instruction.keys;
  if (keys.length < 7) {
    dataLog.debug({ keyCount: keys.length }, 'Orca swap has fewer accounts than expected');
    return null;
  }

  // Determine input/output based on direction and amount specification
  let amountIn: bigint;
  let minAmountOut: bigint;
  let tokenIn: string;
  let tokenOut: string;

  if (amountSpecifiedIsInput) {
    amountIn = amount;
    minAmountOut = otherAmountThreshold;
  } else {
    // Amount specifies output; threshold is max input
    amountIn = otherAmountThreshold;
    minAmountOut = amount;
  }

  if (aToB) {
    tokenIn = keys[3].pubkey.toString();  // Token owner account A
    tokenOut = keys[5].pubkey.toString(); // Token owner account B
  } else {
    tokenIn = keys[5].pubkey.toString();  // Token owner account B
    tokenOut = keys[3].pubkey.toString(); // Token owner account A
  }

  return {
    dex: 'orca',
    poolAddress: keys[2].pubkey.toString(), // Whirlpool account
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut,
    userAccount: keys[1].pubkey.toString(), // Token authority (signer)
  };
}

// ═══════════════════════════════════════════════════════════════
// Jupiter Aggregator decoder
// ═══════════════════════════════════════════════════════════════

function isJupiterRoute(data: Buffer): boolean {
  if (data.length < 8) return false;
  return data.subarray(0, 8).equals(JUPITER_ROUTE_DISCRIMINATOR) ||
         data.subarray(0, 8).equals(JUPITER_SHARED_ROUTE_DISCRIMINATOR);
}

/**
 * Jupiter v6 route instruction layout:
 *   [0..8]   8-byte discriminator
 *   [8]      u8  routePlan length
 *   [9..17]  u64 inAmount
 *   [17..25] u64 quotedOutAmount
 *   [25..27] u16 slippageBps
 *   [27]     u8  platformFeeBps
 *
 * Account layout varies by route, but common positions:
 *   0: token program
 *   1: user transfer authority (signer / wallet)
 *   2: user source token account
 *   3: user destination token account
 *   remaining: route-specific intermediate accounts
 *
 * For sharedAccountsRoute, the layout shifts slightly:
 *   0: token program
 *   1: program authority
 *   2: user transfer authority (signer)
 *   3: source token account
 *   4: program source token account
 *   5: program destination token account
 *   6: destination token account
 */
function decodeJupiterRoute(instruction: TransactionInstruction): SwapDetails | null {
  const data = instruction.data;

  if (!isJupiterRoute(data)) return null;

  const isSharedRoute = data.subarray(0, 8).equals(JUPITER_SHARED_ROUTE_DISCRIMINATOR);

  // Minimum data length for reading amounts
  if (data.length < 25) {
    dataLog.debug({ dataLen: data.length }, 'Jupiter route data too short');
    return null;
  }

  // Parse amounts - layout may shift by 1 byte if routePlan length prefix is present
  let inAmount: bigint;
  let quotedOutAmount: bigint;

  try {
    // Try standard layout first: discriminator(8) + routePlanLen(1) + inAmount(8)
    inAmount = data.readBigUInt64LE(9);
    quotedOutAmount = data.readBigUInt64LE(17);

    // Sanity check: amounts should be reasonable (not astronomical values
    // that suggest we're reading from wrong offset)
    if (inAmount > BigInt('18446744073709551615') / 2n) {
      // Try alternative offset without routePlanLen byte
      inAmount = data.readBigUInt64LE(8);
      quotedOutAmount = data.readBigUInt64LE(16);
    }
  } catch {
    dataLog.debug('Failed to read Jupiter amounts from instruction data');
    return null;
  }

  const keys = instruction.keys;

  if (isSharedRoute) {
    if (keys.length < 7) {
      dataLog.debug({ keyCount: keys.length }, 'Jupiter shared route has fewer accounts than expected');
      return null;
    }

    return {
      dex: 'jupiter',
      poolAddress: instruction.programId.toString(), // Jupiter itself acts as the pool abstraction
      tokenIn: keys[3].pubkey.toString(),            // Source token account
      tokenOut: keys[6].pubkey.toString(),           // Destination token account
      amountIn: inAmount,
      minAmountOut: quotedOutAmount,
      userAccount: keys[2].pubkey.toString(),        // User transfer authority
    };
  }

  // Standard route
  if (keys.length < 4) {
    dataLog.debug({ keyCount: keys.length }, 'Jupiter route has fewer accounts than expected');
    return null;
  }

  return {
    dex: 'jupiter',
    poolAddress: instruction.programId.toString(),
    tokenIn: keys[2].pubkey.toString(),     // User source token account
    tokenOut: keys[3].pubkey.toString(),    // User destination token account
    amountIn: inAmount,
    minAmountOut: quotedOutAmount,
    userAccount: keys[1].pubkey.toString(), // User transfer authority
  };
}

// ═══════════════════════════════════════════════════════════════
// Batch decoding utilities
// ═══════════════════════════════════════════════════════════════

/**
 * Decode all swap instructions from a list of instructions.
 * Useful for processing entire transactions at once.
 */
export function decodeAllSwaps(
  instructions: TransactionInstruction[]
): SwapDetails[] {
  const swaps: SwapDetails[] = [];

  for (const instruction of instructions) {
    try {
      const details = decodeSwapInstruction(instruction);
      if (details) {
        swaps.push(details);
      }
    } catch (err) {
      dataLog.error({ err }, 'Error decoding instruction in batch');
    }
  }

  return swaps;
}

/**
 * Identify which DEX a program ID belongs to.
 */
export function identifyDex(programId: string): DexName {
  if (programId === RAYDIUM_AMM_PROGRAM.toString()) return 'raydium';
  if (programId === ORCA_WHIRLPOOL_PROGRAM.toString()) return 'orca';
  if (programId === JUPITER_AGGREGATOR_PROGRAM.toString()) return 'jupiter';
  return 'unknown';
}

/**
 * Check if a program ID belongs to any known DEX.
 */
export function isKnownDex(programId: string): boolean {
  return identifyDex(programId) !== 'unknown';
}

// ═══════════════════════════════════════════════════════════════
// Re-export all types for consumer convenience
// ═══════════════════════════════════════════════════════════════

export type {
  // Types are exported inline via their declarations above
};
