
/*
 * ARBITRAGE BOT v3.0 - "The Competitor"
 *
 * This bot is a significant architectural upgrade.
 * 1. EVENT-DRIVEN: Runs on every new block via provider.on('block', ...), not setInterval.
 * 2. MARKET-AWARE: Scans PancakeSwap V3 and 1inch Aggregator in addition to all V2 DEXs.
 * 3. FAST: Uses parallel processing and a smart, multi-DEX getAmountOut function.
 */
const { ethers } = require('ethers')
const chalk = require('chalk')
require('dotenv').config()

let fetchInstance = null
async function getFetch() {
  if (typeof fetch !== 'undefined') return fetch
  if (!fetchInstance) {
    fetchInstance = import('node-fetch').then(module => module.default || module)
  }
  return fetchInstance
}

const DEBUG = false // Set to true for very noisy (but useful) logs

// ---------- Config ----------
const RPC_URL = process.env.BSC_RPC_URL // Your paid dRPC
const PRIVATE_KEY = process.env.PRIVATE_KEY
const ONEINCH_API_KEY = process.env.ONEINCH_API_KEY
if (!PRIVATE_KEY) {
  console.error('Set PRIVATE_KEY in environment variables')
  process.exit(1)
}

const provider = new ethers.JsonRpcProvider(RPC_URL)
const wallet = new ethers.Wallet(PRIVATE_KEY, provider)

// Your contract (make sure it's ready for real data)
const ARB_CONTRACT_ADDRESS = '0xb1191353E296D072d5b616F7A37c96094f80F54A'
const ARB_CONTRACT_ABI = [
  'function executeArbitrage(address fromToken,address toToken,uint256 amount,bytes dexData) external'
]
const arbContract = new ethers.Contract(ARB_CONTRACT_ADDRESS, ARB_CONTRACT_ABI, wallet)

// --- NEW DEX CONFIG (V2, V3, and AGGREGATORS) ---
const DEXS = {
  PancakeSwapV2: {
    type: 'V2',
    router: ethers.getAddress('0x10ED43C718714eb63d5aA57B78B54704E256024E'),
    factory: ethers.getAddress('0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73')
  },
  Biswap: {
    type: 'V2',
    router: ethers.getAddress('0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8'),
    factory: ethers.getAddress('0x858E3312ed3A876947EA49d572A7C42DE08af7EE')
  },
  ApeSwap: {
    type: 'V2',
    router: ethers.getAddress('0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7'),
    factory: ethers.getAddress('0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6')
  },
  BakerySwap: {
    type: 'V2',
    router: ethers.getAddress('0xCDe540d7eAFE93aC5fE6233Bee57E1270D3E330F'),
    factory: ethers.getAddress('0x01bF7C66c6BD861915CdaaE475042d3c4BaE16A7')
  },
  MDEX: {
    type: 'V2',
    router: ethers.getAddress('0x7DAe51BD3E3376B8c7c4900E9107f12Be3AF1bA8'),
    factory: ethers.getAddress('0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062B8')
  },
  
  // --- This is where the real opportunities are ---
  OneInch: {
    type: 'AGGREGATOR', // Requires HTTP quoting through 1inch API
    router: ethers.getAddress('0x1111111254EEB25477B68fb85Ed929f73A960582'),
    factory: null,
    requiresApiKey: true
  },
  PancakeSwapV3: {
    type: 'V3',
    router: ethers.getAddress('0x1b81D678ffb9C0263b24A97847620C99d213eB14'), // This is the V3 Router
    quoter: ethers.getAddress('0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'), // This is the V3 Quoter
    factory: null 
  }
}

// --- ABIs ---
const ROUTER_V2_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)',
  'function factory() external view returns (address)'
]
const FACTORY_V2_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)'
]
// 1inch Aggregator uses the same getAmountsOut ABI as V2
const ROUTER_AGGREGATOR_ABI = ROUTER_V2_ABI

const QUOTER_V3_ABI = [
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external view returns (uint256 amountOut)',
  'function quoteExactInput(bytes memory path, uint256 amountIn) external returns (uint256 amountOut)'
]
// V3 Fee Tiers
const V3_FEE_TIERS = [100, 500, 2500, 10000]; // 0.01%, 0.05%, 0.25%, 1%

// --- TOKENS ---
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const TOP_TOKENS = [
  { symbol: 'WBNB', address: WBNB, decimals: 18 },
  { symbol: 'BUSD', address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18 },
  { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
  { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  { symbol: 'CAKE', address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18 },
  { symbol: 'ETH', address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', decimals: 18 },
  { symbol: 'BTCB', address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', decimals: 18 },
  { symbol: 'FLOKI', address: '0xfb5b838b6cfeedc2873ab27866079ac55363d37e', decimals: 9 },
  { symbol: 'BABYDOGE', address: '0xc748673057861a797275cd8a068abb95a902e8de', decimals: 9 }, // Decimals are 9
]

const TOKEN_BY_ADDRESS = TOP_TOKENS.reduce((map, token) => {
  map.set(ethers.getAddress(token.address), token)
  return map
}, new Map())

const BRIDGE_TOKENS = [
  ethers.getAddress(WBNB),
  ethers.getAddress('0x55d398326f99059fF775485246999027B3197955'), // USDT
  ethers.getAddress('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d')  // USDC
]

// --- SETTINGS ---
const FLASH_LOAN_FEE_BPS = 9 // 0.09%
const GAS_ESTIMATE_TOTAL = 800_000n // Total gas for flash loan + 2 swaps (V3/Agg can be higher)
let gasPriceWeiCache = ethers.parseUnits('3', 'gwei') // Start with 3 gwei

const MIN_PROFIT_USD = 2.0 // $2.00 threshold
const MAX_PRICE_IMPACT_BPS = 400 // 4% price impact threshold
const PRICE_IMPACT_SAMPLE_DIVISOR = 20n // Use 5% of trade size to estimate slippage
const LOAN_AMOUNTS_BUSD = [
  '500',    // $500
  '2500',   // $2,500
  '10000',  // $10,000
  '25000',  // $25,000
  '50000'   // $50,000
]
const BASE_TOKEN = TOP_TOKENS.find(t => t.symbol === 'BUSD')

// --- Global Contracts & Caches ---
const dexContracts = {}
const pairExistenceCache = new Map()
const priceCache = new Map()
const PRICE_CACHE_TTL = 1500 // 1.5 seconds. Must be less than block time.

const stats = {
  scans: 0,
  opportunities: 0,
  executed: 0,
  failed: 0,
  pairChecksFailed: 0,
  lastScanTime: 0,
  totalProfit: 0n
}

// ---------- 1. Initialization ----------
async function initializeContracts() {
  console.log(chalk.cyan('🔄 Initializing DEX contracts...'))
  for (const [name, dex] of Object.entries(DEXS)) {
    let routerContract, factory, quoter
    const routerAddress = dex.router ? ethers.getAddress(dex.router) : null
    if (dex.type === 'V2') {
      routerContract = new ethers.Contract(routerAddress, ROUTER_V2_ABI, provider)
      factory = new ethers.Contract(dex.factory, FACTORY_V2_ABI, provider)
    } else if (dex.type === 'V3') {
      if (routerAddress) {
        routerContract = new ethers.Contract(routerAddress, ROUTER_V2_ABI, provider)
      }
      quoter = new ethers.Contract(dex.quoter, QUOTER_V3_ABI, provider)
    } else if (dex.type === 'AGGREGATOR') {
      if (!ONEINCH_API_KEY) {
        console.log(chalk.yellow(`⚠️  Skipping ${name} quotes (missing ONEINCH_API_KEY)`))
      }
    }
    dexContracts[name] = { 
      router: routerContract, 
      routerAddress, 
      factory, 
      quoter, 
      type: dex.type, 
      requiresApiKey: dex.requiresApiKey === true 
    }
  }
  await refreshGasPriceWei()
  console.log(chalk.green('✅ All DEXs initialized.'))
}

// ---------- 2. Helpers ----------
async function refreshGasPriceWei() {
  try {
    const feeData = await provider.getFeeData()
    const newGasPrice = feeData.gasPrice
    if (newGasPrice && newGasPrice > 0n) {
      gasPriceWeiCache = newGasPrice
      if (DEBUG) console.log(chalk.gray(`Gas price updated: ${ethers.formatUnits(gasPriceWeiCache, 'gwei')} gwei`))
    }
  } catch (e) {
    console.log(chalk.yellow(`Could not refresh gas price: ${e.message}`))
  }
}

async function checkPairExists(dexName, tokenA, tokenB) {
  const dex = dexContracts[dexName]
  if (dex.type !== 'V2' || !dex.factory) return true 

  const token0 = ethers.getAddress(tokenA)
  const token1 = ethers.getAddress(tokenB)
  const [addrA, addrB] = token0.toLowerCase() < token1.toLowerCase()
    ? [token0, token1]
    : [token1, token0]

  const cacheKey = `${dexName}-${addrA}-${addrB}`
  if (pairExistenceCache.has(cacheKey)) {
    return pairExistenceCache.get(cacheKey)
  }

  try {
    const pairAddr = await dex.factory.getPair(addrA, addrB)
    const exists = pairAddr !== ethers.ZeroAddress
    pairExistenceCache.set(cacheKey, exists)
    return exists
  } catch (err) {
    pairExistenceCache.set(cacheKey, false)
    return false
  }
}

function keyForPath(path) {
  return path.map(addr => ethers.getAddress(addr)).join('>')
}

function generateV2Paths(tokenIn, tokenOut) {
  const start = ethers.getAddress(tokenIn)
  const end = ethers.getAddress(tokenOut)
  const paths = new Map()
  const direct = [start, end]
  paths.set(keyForPath(direct), direct)

  for (const bridge of BRIDGE_TOKENS) {
    if (bridge === start || bridge === end) continue
    const path = [start, bridge, end]
    paths.set(keyForPath(path), path)
  }

  return Array.from(paths.values())
}

function encodeV3Path(tokens, fees) {
  if (tokens.length !== fees.length + 1) {
    throw new Error('V3 path tokens/fees length mismatch')
  }
  const types = []
  const values = []
  tokens.forEach((token, idx) => {
    types.push('address')
    values.push(token)
    if (idx < fees.length) {
      types.push('uint24')
      values.push(fees[idx])
    }
  })
  return ethers.solidityPacked(types, values)
}

// Helper to check if an error is an expected V3 pool error (pool doesn't exist)
function isExpectedV3Error(err) {
  if (!err) return false
  const errorMsg = err.message || err.toString() || ''
  const errorCode = err.code || ''
  
  // Common V3 quoter errors that indicate pool doesn't exist
  return (
    errorMsg.includes('revert') ||
    errorMsg.includes('CALL_EXCEPTION') ||
    errorMsg.includes('execution reverted') ||
    errorMsg.includes('missing revert data') ||
    errorCode === 'CALL_EXCEPTION'
  )
}

function generateV3Paths(tokenIn, tokenOut) {
  const start = ethers.getAddress(tokenIn)
  const end = ethers.getAddress(tokenOut)
  const candidates = []

  for (const fee of V3_FEE_TIERS) {
    candidates.push({
      tokens: [start, end],
      fees: [fee]
    })
  }

  for (const bridge of BRIDGE_TOKENS) {
    if (bridge === start || bridge === end) continue
    for (const feeIn of V3_FEE_TIERS) {
      for (const feeOut of V3_FEE_TIERS) {
        candidates.push({
          tokens: [start, bridge, end],
          fees: [feeIn, feeOut]
        })
      }
    }
  }

  return candidates
}

async function getOneInchQuote(tokenIn, tokenOut, amountIn) {
  if (!ONEINCH_API_KEY) return undefined
  try {
    const fetchFn = await getFetch()
    const url = new URL('https://api.1inch.dev/swap/v5.2/56/quote')
    url.searchParams.set('src', ethers.getAddress(tokenIn))
    url.searchParams.set('dst', ethers.getAddress(tokenOut))
    url.searchParams.set('amount', amountIn.toString())
    url.searchParams.set('includeTokensInfo', 'false')
    url.searchParams.set('includeProtocols', 'false')

    const response = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${ONEINCH_API_KEY}`,
        accept: 'application/json'
      }
    })

    if (!response.ok) {
      if (DEBUG) {
        console.log(chalk.gray(`1inch quote failed ${response.status} ${response.statusText}`))
      }
      return undefined
    }

    const data = await response.json()
    if (!data.dstAmount) return undefined
    return {
      amountOut: BigInt(data.dstAmount),
      path: [ethers.getAddress(tokenIn), ethers.getAddress(tokenOut)],
      meta: data
    }
  } catch (err) {
    if (DEBUG) console.log(chalk.gray(`1inch quote error: ${err.message || err}`))
    return undefined
  }
}

async function checkPathExists(dexName, path) {
  for (let i = 0; i < path.length - 1; i++) {
    const exists = await checkPairExists(dexName, path[i], path[i + 1])
    if (!exists) {
      return false
    }
  }
  return true
}

async function estimateV2PriceImpactBps(dexName, path, amountIn, amountOut) {
  const dex = dexContracts[dexName]
  if (!dex || !dex.router) return 0
  const sampleIn = amountIn / PRICE_IMPACT_SAMPLE_DIVISOR
  if (sampleIn === 0n) return 0
  try {
    const sampleAmounts = await dex.router.getAmountsOut(sampleIn, path)
    const sampleOut = sampleAmounts[sampleAmounts.length - 1]
    if (sampleOut === 0n) return 10_000
    const numerator = sampleOut * amountIn - amountOut * sampleIn
    if (numerator <= 0n) return 0
    const denominator = sampleOut * amountIn
    if (denominator === 0n) return 10_000
    const impactBps = (numerator * 10000n) / denominator
    return Number(impactBps)
  } catch (err) {
    if (DEBUG) {
      console.log(chalk.gray(`${dexName} price impact estimation error (${path.join('->')}): ${err.message || err}`))
    }
    return 0
  }
}

/**
 * NEW: Smart quoting function for V2, V3, and Aggregators
 */
async function getBestQuote(dexName, tokenIn, tokenOut, amountIn) {
  const dex = dexContracts[dexName]
  if (!dex) return undefined

  const normalizedIn = ethers.getAddress(tokenIn)
  const normalizedOut = ethers.getAddress(tokenOut)

  if (dex.requiresApiKey && !ONEINCH_API_KEY) {
    return undefined
  }

  const candidateCacheKey = `${dexName}-${normalizedIn}-${normalizedOut}-${amountIn.toString()}`
  const cached = priceCache.get(candidateCacheKey)
  if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL) {
    return cached.value
  }

  try {
    let bestQuote = { amountOut: 0n }

    if (dex.type === 'V2') {
      const paths = generateV2Paths(normalizedIn, normalizedOut)
      for (const path of paths) {
        if (!(await checkPathExists(dexName, path))) {
          stats.pairChecksFailed++
          continue
        }
        try {
          const amounts = await dex.router.getAmountsOut(amountIn, path)
          const amountOut = amounts[amounts.length - 1]
          if (amountOut > bestQuote.amountOut) {
            bestQuote = { amountOut, path, dexType: dex.type }
          }
        } catch (err) {
          if (DEBUG) console.log(chalk.gray(`${dexName} getAmountsOut error (${path.join('->')}): ${err.message || err}`))
        }
      }
    } else if (dex.type === 'AGGREGATOR') {
      const quote = await getOneInchQuote(normalizedIn, normalizedOut, amountIn)
      if (quote && quote.amountOut > 0n) {
        bestQuote = { ...quote, dexType: dex.type }
      }
    } else if (dex.type === 'V3') {
      const pathCandidates = generateV3Paths(normalizedIn, normalizedOut)
      for (const candidate of pathCandidates) {
        try {
          let amountOut
          
          // Use quoteExactInputSingle for single-hop swaps (more efficient and reliable)
          if (candidate.tokens.length === 2) {
            const fee = candidate.fees[0]
            // sqrtPriceLimitX96 = 0 means no price limit
            amountOut = await dex.quoter.quoteExactInputSingle.staticCall(
              candidate.tokens[0],
              candidate.tokens[1],
              fee,
              amountIn,
              0n // sqrtPriceLimitX96 = 0 (no limit)
            )
          } else {
            // Multi-hop: use quoteExactInput with encoded path
            const encodedPath = encodeV3Path(candidate.tokens, candidate.fees)
            amountOut = await dex.quoter.quoteExactInput.staticCall(encodedPath, amountIn)
          }
          
          if (amountOut && amountOut > bestQuote.amountOut) {
            bestQuote = { amountOut, path: candidate.tokens, fees: candidate.fees, dexType: dex.type }
          }
        } catch (err) {
          // Silently skip if pool doesn't exist or quote fails
          // This is expected behavior - not all fee tiers have pools for all token pairs
          if (DEBUG && !isExpectedV3Error(err)) {
            const errorMsg = err.message || err.toString()
            console.log(chalk.gray(`${dexName} V3 quote error (${candidate.tokens.join('->')}): ${errorMsg}`))
          }
          // Expected errors (pool doesn't exist) are silently ignored
        }
      }
    }

    if (bestQuote.amountOut > 0n) {
      priceCache.set(candidateCacheKey, { value: bestQuote, timestamp: Date.now() })
      return bestQuote
    }
    return undefined
  } catch (err) {
    if (DEBUG) console.log(chalk.gray(`${dexName} quote error: ${err.message || err}`))
    return undefined
  }
}

async function getGasCostInBaseToken() {
  const gasCostWei = gasPriceWeiCache * GAS_ESTIMATE_TOTAL // WBNB
  
  try {
    // Get quote to convert WBNB gas cost to BUSD
    const router = dexContracts['PancakeSwapV2'].router
    const amounts = await router.getAmountsOut(gasCostWei, [WBNB, BASE_TOKEN.address])
    return amounts[1] || 0n
  } catch {
    // Fallback: 0.01 WBNB ~ $5 at 3 gwei
    return ethers.parseUnits('5', BASE_TOKEN.decimals) 
  }
}

// ---------- 3. Core Scan Logic ----------

async function scanPair(tokenA, tokenB, amountIn) {
  const tokenInAddr = tokenA.address
  const tokenOutAddr = tokenB.address

  // 1. Get prices from ALL DEXs for this LARGE amount (in parallel)
  const dexNames = Object.keys(dexContracts)
  const pricePromises = dexNames.map(dexName => 
    getBestQuote(dexName, tokenInAddr, tokenOutAddr, amountIn)
  )
  const priceResults = await Promise.allSettled(pricePromises)
  
  const pricesOut = {}
  dexNames.forEach((dexName, i) => {
    const result = priceResults[i]
    if (result.status === 'fulfilled' && result.value) {
      pricesOut[dexName] = { 
        routerAddress: dexContracts[dexName].routerAddress, 
        quote: result.value 
      }
    }
  })

  if (Object.keys(pricesOut).length < 2) return null // Not enough prices to compare

  // 2. Find best buy (most TokenB for TokenA)
  let bestBuy = { dexName: null, routerAddress: null, amountOut: 0n, quote: null }
  for (const [dexName, data] of Object.entries(pricesOut)) {
    if (data.quote.amountOut > bestBuy.amountOut) {
      bestBuy = { dexName, routerAddress: data.routerAddress, amountOut: data.quote.amountOut, quote: data.quote }
    }
  }

  if (!bestBuy.dexName) return null
  
  // 3. Find best sell (most TokenA for TokenB)
  const amountToSell = bestBuy.amountOut
  if (amountToSell === 0n) return null

  const sellDexNames = Object.keys(dexContracts)
  const sellPricePromises = sellDexNames.map(dexName => {
    // Don't sell on the same DEX we bought from
    if (dexName === bestBuy.dexName) return Promise.resolve(undefined)
    return getBestQuote(dexName, tokenOutAddr, tokenInAddr, amountToSell)
  })
  const sellPriceResults = await Promise.allSettled(sellPricePromises)
  
  let bestSell = { dexName: null, routerAddress: null, amountOut: 0n, quote: null }
  sellDexNames.forEach((dexName, i) => {
    const result = sellPriceResults[i]
    if (result.status === 'fulfilled' && result.value) {
      if (result.value.amountOut > bestSell.amountOut) {
        bestSell = { 
          dexName, 
          routerAddress: dexContracts[dexName].routerAddress, 
          amountOut: result.value.amountOut,
          quote: result.value
        }
      }
    }
  })

  if (!bestSell.dexName) return null

  if (bestBuy.quote?.dexType === 'V2' && bestBuy.quote?.path?.length >= 2) {
    const priceImpactBuyBps = await estimateV2PriceImpactBps(bestBuy.dexName, bestBuy.quote.path, amountIn, bestBuy.amountOut)
    if (priceImpactBuyBps > MAX_PRICE_IMPACT_BPS) {
      if (DEBUG) {
        console.log(chalk.gray(`  Skipping opportunity due to buy-side price impact ${priceImpactBuyBps} bps`))
      }
      return null
    }
  }

  if (bestSell.quote?.dexType === 'V2' && bestSell.quote?.path?.length >= 2) {
    const priceImpactSellBps = await estimateV2PriceImpactBps(bestSell.dexName, bestSell.quote.path, amountToSell, bestSell.amountOut)
    if (priceImpactSellBps > MAX_PRICE_IMPACT_BPS) {
      if (DEBUG) {
        console.log(chalk.gray(`  Skipping opportunity due to sell-side price impact ${priceImpactSellBps} bps`))
      }
      return null
    }
  }

  // 4. Calculate Profit
  const finalAmountOut = bestSell.amountOut
  if (finalAmountOut <= amountIn) return null // No raw profit

  const rawProfit = finalAmountOut - amountIn
  
  // DEBUG LOG: We found a raw profit!
  const rawProfitFloat = parseFloat(ethers.formatUnits(rawProfit, tokenA.decimals));
  console.log(chalk.blue(
    `  [RAW PROFIT]: ${tokenB.symbol} | $${ethers.formatUnits(amountIn, tokenA.decimals)} | ${bestBuy.dexName} -> ${bestSell.dexName} | Raw: $${rawProfitFloat.toFixed(2)}`
  ));
  
  const flashLoanFee = (amountIn * BigInt(FLASH_LOAN_FEE_BPS)) / 10000n
  const gasCost = await getGasCostInBaseToken()
  
  // No safety buffer, we rely on our fast execution
  const netProfit = rawProfit - flashLoanFee - gasCost

  if (netProfit <= 0n) return null

  const netProfitFloat = parseFloat(ethers.formatUnits(netProfit, tokenA.decimals))

  if (netProfitFloat < MIN_PROFIT_USD) {
     if (DEBUG) console.log(chalk.yellow(`  Found net profit of $${netProfitFloat.toFixed(2)}, but below $${MIN_PROFIT_USD} min.`))
     return null
  }

  // --- WE FOUND ONE ---
  return {
    tokenA, // BUSD
    tokenB, // The volatile token
    amountIn, // The loan amount
    buyDex: bestBuy.dexName,
    buyDexType: bestBuy.quote?.dexType,
    buyRouter: bestBuy.routerAddress,
    buyPath: bestBuy.quote?.path || [tokenA.address, tokenB.address],
    buyFees: bestBuy.quote?.fees || [],
    sellDex: bestSell.dexName,
    sellDexType: bestSell.quote?.dexType,
    sellRouter: bestSell.routerAddress,
    sellPath: bestSell.quote?.path || [tokenB.address, tokenA.address],
    sellFees: bestSell.quote?.fees || [],
    netProfit,
    netProfitFloat,
  }
}

async function onBlockScan() {
  stats.scans++
  const scanStartTime = Date.now()
  if (DEBUG) console.log(chalk.cyan(`\n🔍 Scan #${stats.scans}...`))
  
  // Clear cache for new block
  priceCache.clear()

  const opportunities = []
  const scanPromises = []

  // Loop through all volatile tokens
  for (const tokenB of TOP_TOKENS) {
    if (tokenB.address === BASE_TOKEN.address) continue

    // Loop through all loan amounts
    for (const loanAmount of LOAN_AMOUNTS_BUSD) {
      const amountIn = ethers.parseUnits(loanAmount, BASE_TOKEN.decimals)
      // Wrap in error handling to prevent one failure from breaking the scan
      scanPromises.push(
        scanPair(BASE_TOKEN, tokenB, amountIn).catch(err => {
          if (DEBUG) {
            console.log(chalk.gray(`Scan error for ${tokenB.symbol} ${loanAmount}: ${err.message || err}`))
          }
          return null
        })
      )
    }
  }

  // Process results with timeout protection
  let results
  try {
    results = await Promise.race([
      Promise.allSettled(scanPromises),
      new Promise((resolve) => {
        setTimeout(() => {
          console.log(chalk.yellow(`  ⚠️  Scan timeout after 2s, processing partial results...`))
          resolve('timeout')
        }, 2000)
      })
    ])
  } catch (err) {
    if (DEBUG) console.log(chalk.gray(`Scan error: ${err.message || err}`))
    return
  }
  
  if (results === 'timeout') {
    if (DEBUG) console.log(chalk.gray(`Scan timed out. Scan took ${Date.now() - scanStartTime}ms`))
    return
  }

  results.forEach(result => {
    if (result.status === 'fulfilled' && result.value) {
      opportunities.push(result.value)
    } else if (result.status === 'rejected') {
      if (DEBUG) {
        console.log(chalk.gray(`  Scan promise rejected: ${result.reason?.message || result.reason}`))
      }
    }
  })

  if (opportunities.length === 0) {
    if (DEBUG) console.log(chalk.gray(`No opportunities found this block. Scan took ${Date.now() - scanStartTime}ms`))
    return
  }

  // Sort by profitability and pick the best one
  opportunities.sort((a, b) => Number(b.netProfit - a.netProfit))
  const best = opportunities[0]
  
  stats.opportunities++
  console.log(chalk.green.bold(`\n🎯🎯🎯 SPATIAL ARBITRAGE FOUND! (Scan ${stats.scans}) 🎯🎯🎯`))
  console.log(chalk.green(`  TIME: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`));
  console.log(chalk.green(`  TOKEN: ${best.tokenB.symbol}`))
  console.log(chalk.green(`  LOAN: ${ethers.formatUnits(best.amountIn, best.tokenA.decimals)} ${best.tokenA.symbol}`))
  console.log(chalk.green(`  BUY ON: ${best.buyDex} -> SELL ON: ${best.sellDex}`))
  console.log(chalk.green.bold(`  EST. NET PROFIT: $${best.netProfitFloat.toFixed(2)} ${best.tokenA.symbol}`))
  console.log(chalk.gray(`  Scan took ${Date.now() - scanStartTime}ms`));

  await executeArbitrage(best)
}

// ---------- 4. Execution ----------
async function executeArbitrage(opp) {
  try {
    console.log(chalk.magenta(`\n⚡ ATTEMPTING EXECUTION...`))
    if (!opp.buyRouter || !opp.sellRouter) {
      console.log(chalk.yellow('  Skipping execution: missing router address for opportunity.'))
      return
    }

    if (opp.buyDexType !== 'V2' || opp.sellDexType !== 'V2') {
      console.log(chalk.yellow(`  Skipping execution: unsupported dex types (${opp.buyDexType} -> ${opp.sellDexType}).`))
      return
    }

    if (opp.buyPath.length !== 2 || opp.sellPath.length !== 2) {
      console.log(chalk.yellow('  Skipping execution: multi-hop paths not yet supported by execution contract.'))
      return
    }
    
    // 1. Encode dexData for your contract
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    
    // We get the router addresses directly from the opportunity object
    const dexData = abiCoder.encode(
      ['address', 'address'], // The data types we are packing
      [opp.buyRouter, opp.sellRouter] // The actual router addresses
    );
    
    // 2. Estimate Gas
    const gasLimit = GAS_ESTIMATE_TOTAL + 100_000n // Add buffer

    // 3. Send Transaction
    // This is where you would integrate a private relay (e.g., Flashbots)
    // For now, we send a standard transaction.
    const tx = await arbContract.executeArbitrage(
      opp.tokenA.address,  // fromToken (BUSD)
      opp.tokenB.address,  // toToken (e.g., AXS)
      opp.amountIn,        // The loan amount
      dexData,             // Your packed router data
      { 
        gasLimit: gasLimit,
        gasPrice: gasPriceWeiCache // Use the cached, fast gas price
      }
    );

    console.log(chalk.magenta(`  Sent tx: ${tx.hash}`))
    stats.executed++
    
    const receipt = await tx.wait()
    
    if (receipt.status === 1) {
      console.log(chalk.green.bold(`  ✅✅✅ EXECUTION SUCCESSFUL! ✅✅✅`))
      stats.totalProfit += opp.netProfit
    } else {
      stats.failed++
      console.log(chalk.red(`  ❌ Transaction FAILED (Reverted)`))
    }
    
  } catch (err) {
    stats.failed++
    console.log(chalk.red(`  ❌ Execution error: ${err?.reason || err?.message || err}`))
  }
}

// ---------- 5. Entrypoint ----------
(async () => {
  try {
    // Suppress unhandled promise rejections for expected errors (like V3 pool not found)
    process.on('unhandledRejection', (reason, promise) => {
      // Only log unexpected errors
      if (!isExpectedV3Error(reason)) {
        if (DEBUG) {
          console.error(chalk.red('Unhandled Rejection:', reason))
        }
      }
      // Expected errors are silently ignored
    })

    const net = await provider.getNetwork()
    console.log(chalk.cyan(`\n╔═══════════════════════════════════════╗`))
    console.log(chalk.cyan(`║     BSC ARBITRAGE BOT v3.0 (COMPETITOR) ║`))
    console.log(chalk.cyan(`╚═══════════════════════════════════════╝`))
    console.log(chalk.cyan(`🏦 Chain ID: ${net.chainId}`))
    console.log(chalk.cyan(`🔑 Wallet: ${await wallet.getAddress()}`))
    console.log(chalk.cyan(`💰 Min Profit: $${MIN_PROFIT_USD} BUSD`))

    await initializeContracts()
    
    console.log(chalk.cyan(`⛽ Initial Gas: ${ethers.formatUnits(gasPriceWeiCache, 'gwei')} gwei`))
    console.log(chalk.yellow("\nListening for new blocks... (This is the correct architecture)\n"))
    
    // Refresh gas price every 30 seconds in the background
    setInterval(refreshGasPriceWei, 30_000)

    let isScanning = false
    let lastBlockProcessed = 0

    // --- THIS IS THE CORRECT EVENT-BASED ENGINE ---
    provider.on('block', async (blockNumber) => {
      if (DEBUG) console.log(chalk.gray(`\nNew Block: ${blockNumber}`))

      // Skip if we're already scanning or if this block was already processed
      if (isScanning) {
        if (DEBUG) console.log(chalk.yellow(`  Scan in progress, skipping block ${blockNumber}`))
        return
      }

      // Prevent processing the same block twice
      if (blockNumber <= lastBlockProcessed) {
        if (DEBUG) console.log(chalk.yellow(`  Block ${blockNumber} already processed, skipping`))
        return
      }

      isScanning = true
      lastBlockProcessed = blockNumber

      try {
        // Use Promise.race with timeout to ensure we don't block too long
        await Promise.race([
          onBlockScan(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Scan timeout')), 3000)
          )
        ])
      } catch (e) {
        // Only log non-timeout errors
        if (!e.message.includes('timeout')) {
          console.error(chalk.red(`Error during scan for block ${blockNumber}: ${e.message}`))
        } else if (DEBUG) {
          console.log(chalk.yellow(`  Scan for block ${blockNumber} timed out, continuing...`))
        }
      } finally {
        // Always reset scanning flag, even on error
        isScanning = false
      }
    });

  } catch (e) {
    console.error(chalk.red(`Fatal Error on Startup: ${e.message}`))
    console.error(e)
    process.exit(1)
  }
})()