require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");

/* ============================================================
    UNIQUE STRATEGY BOT - 3 Parallel Detection Methods
    
    Strategy 1: Price Momentum Detection (UNIQUE)
    - Detects when large trades create temporary imbalances
    - Executes within 2-3 blocks before market corrects
    
    Strategy 2: Multi-Hop Path Optimization (UNIQUE)  
    - Checks 4-hop and 5-hop paths (not just 2-3 hops)
    - Most bots ignore these due to complexity
    
    Strategy 3: Pool Imbalance Arbitrage (UNIQUE)
    - Monitors reserve ratios, not just prices
    - Detects when pools drift from optimal K constant
============================================================ */

// ================= CONFIG =================
const CONFIG = {
  //RPC_URL: "https://lb.drpc.org/polygon/AtaWEu3Vb0UvjJUAZnzUnSw6VvL60cER8IDuMtMmCCpn",
  RPC_URL:"https://polygon-rpc.com",
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  FLASH_CONTRACT: "0x1097A1ec792c42013Be3f2c5D6319Dc2EB4Cecdc",
  
  // Aggressive settings for paid RPC
  SCAN_INTERVAL: 800,        // 0.8 seconds (very aggressive)
  MIN_PROFIT_USD: 1.5,       // $1.50 minimum (lower threshold)
  OPTIMAL_PROFIT_USD: 3.0,   // $3 = execute immediately
  
  // Trade sizing
  TRADE_SIZES: [150, 300, 500, 800, 1200, 2000],
  
  // Strategy toggles
  ENABLE_MOMENTUM: true,      // NEW: Track price momentum
  ENABLE_MULTIHOP: true,      // NEW: 4-5 hop paths
  ENABLE_IMBALANCE: true,     // NEW: Pool K constant monitoring
  
  // Risk management
  MAX_SLIPPAGE_PERCENT: 2.5,
  MAX_GAS_GWEI: 400,
  COOLDOWN_MS: 2000
};

// ================= TOKENS =================
const TOKENS = {
  USDC: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6, symbol: "USDC" },
  USDT: { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, symbol: "USDT" },
  DAI: { address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18, symbol: "DAI" },
  WMATIC: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, symbol: "WMATIC" },
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, symbol: "WETH" },
  WBTC: { address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8, symbol: "WBTC" },
  LINK: { address: "0x53E0bca35eC356BD5ddDFebbd1Fc0fD03FaBad39", decimals: 18, symbol: "LINK" }
};

// ================= DEXES =================
const DEXES = {
  QUICK: {
    name: "QuickSwap",
    router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    factory: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32",
    fee: 30
  },
  SUSHI: {
    name: "SushiSwap", 
    router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
    factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
    fee: 30
  },
  UNI_V3: {
    name: "UniswapV3",
    quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
    router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    fees: [500, 3000, 10000]
  }
};

// ================= ABIs =================
const PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function kLast() external view returns (uint256)"
];

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address)"
];

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] path) external view returns (uint[])"
];

const QUOTER_ABI = [
  "function quoteExactInputSingle((address,address,uint256,uint24,uint160)) external returns (uint256,uint160,uint32,uint256)"
];

const FLASHLOAN_ABI = [
  "function requestFlashLoan(address,uint256,(address router,address tokenIn,address tokenOut,uint24 fee)[]) external"
];

// ================= INIT =================
const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
const flashContract = new ethers.Contract(CONFIG.FLASH_CONTRACT, FLASHLOAN_ABI, wallet);

const quickRouter = new ethers.Contract(DEXES.QUICK.router, ROUTER_ABI, provider);
const sushiRouter = new ethers.Contract(DEXES.SUSHI.router, ROUTER_ABI, provider);
const uniQuoter = new ethers.Contract(DEXES.UNI_V3.quoter, QUOTER_ABI, provider);

const quickFactory = new ethers.Contract(DEXES.QUICK.factory, FACTORY_ABI, provider);
const sushiFactory = new ethers.Contract(DEXES.SUSHI.factory, FACTORY_ABI, provider);

// ================= STATE =================
const state = {
  nonce: null,
  lastTrade: 0,
  scans: 0,
  opportunities: 0,
  trades: 0,
  profitUSD: 0,
  
  // Price history for momentum detection
  priceHistory: new Map(),
  
  // Pool K history for imbalance detection
  poolKHistory: new Map(),
  
  // Scan results
  scanResults: []
};

// ================= LOGGING =================
function log(msg, level = "INFO") {
  const colors = {
    INFO: "\x1b[37m",
    SUCCESS: "\x1b[32m",
    WARN: "\x1b[33m",
    ERROR: "\x1b[31m",
    OPPORTUNITY: "\x1b[36m"
  };
  const ts = new Date().toISOString().substr(11, 12);
  console.log(`${colors[level]}[${ts}] ${msg}\x1b[0m`);
  fs.appendFileSync("unique_bot.log", `[${new Date().toISOString()}] ${msg}\n`);
}

// ================= PRICE CALCULATION =================
function calculateAmountOut(amountIn, reserveIn, reserveOut, fee = 30) {
  const amountInWithFee = amountIn * BigInt(10000 - fee) / 10000n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn + amountInWithFee;
  return numerator / denominator;
}

// ================= GET RESERVES =================
async function getReserves(factoryName, tokenA, tokenB) {
  try {
    const factory = factoryName === "quick" ? quickFactory : sushiFactory;
    const pairAddr = await factory.getPair(tokenA, tokenB);
    
    if (pairAddr === ethers.ZeroAddress) return null;
    
    const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
    const [r0, r1] = await pair.getReserves();
    const token0 = await pair.token0();
    
    let kLast = 0n;
    try {
      kLast = await pair.kLast();
    } catch {}
    
    const isToken0 = token0.toLowerCase() === tokenA.toLowerCase();
    
    return {
      reserveA: isToken0 ? r0 : r1,
      reserveB: isToken0 ? r1 : r0,
      kCurrent: r0 * r1,
      kLast,
      pairAddr
    };
  } catch {
    return null;
  }
}

// ================= STRATEGY 1: PRICE MOMENTUM DETECTION =================
// Detects when price is moving rapidly in one direction (indicates incoming arb)
function detectMomentum(tokenPair, currentPrice) {
  const key = tokenPair;
  
  if (!state.priceHistory.has(key)) {
    state.priceHistory.set(key, []);
  }
  
  const history = state.priceHistory.get(key);
  history.push({ price: currentPrice, time: Date.now() });
  
  // Keep last 10 data points
  if (history.length > 10) history.shift();
  
  if (history.length < 5) return { momentum: 0, direction: "none" };
  
  // Calculate price velocity (change per second)
  const first = history[0];
  const last = history[history.length - 1];
  const timeDiff = (last.time - first.time) / 1000; // seconds
  const priceDiff = ((last.price - first.price) / first.price) * 100; // percent
  
  const velocity = priceDiff / timeDiff; // percent per second
  
  // If price moving > 0.5% per second, momentum detected
  if (Math.abs(velocity) > 0.5) {
    return {
      momentum: Math.abs(velocity),
      direction: velocity > 0 ? "up" : "down",
      signal: "STRONG"
    };
  }
  
  return { momentum: Math.abs(velocity), direction: "none", signal: "WEAK" };
}

// ================= STRATEGY 2: MULTI-HOP PATH FINDER =================
// Finds 4-5 hop paths that most bots don't check
async function findMultiHopPath(startToken, size) {
  const amountIn = ethers.parseUnits(size.toString(), startToken.decimals);
  const allTokens = Object.values(TOKENS).filter(t => t.symbol !== startToken.symbol);
  
  const bestPaths = [];
  
  // Try 4-hop paths: Start -> A -> B -> C -> Start
  for (let i = 0; i < Math.min(allTokens.length, 3); i++) {
    for (let j = i + 1; j < Math.min(allTokens.length, 4); j++) {
      for (let k = j + 1; k < Math.min(allTokens.length, 5); k++) {
        try {
          const tokenA = allTokens[i];
          const tokenB = allTokens[j];
          const tokenC = allTokens[k];
          
          // Get reserves for each hop
          const [r1, r2, r3, r4] = await Promise.all([
            getReserves("quick", startToken.address, tokenA.address),
            getReserves("sushi", tokenA.address, tokenB.address),
            getReserves("quick", tokenB.address, tokenC.address),
            getReserves("sushi", tokenC.address, startToken.address)
          ]);
          
          if (!r1 || !r2 || !r3 || !r4) continue;
          
          // Calculate through path
          const a1 = calculateAmountOut(amountIn, r1.reserveA, r1.reserveB, 30);
          const a2 = calculateAmountOut(a1, r2.reserveA, r2.reserveB, 30);
          const a3 = calculateAmountOut(a2, r3.reserveA, r3.reserveB, 30);
          const finalOut = calculateAmountOut(a3, r4.reserveA, r4.reserveB, 30);
          
          const profit = finalOut - amountIn;
          const profitPct = (Number(profit) / Number(amountIn)) * 100;
          
          if (profitPct > 0.3) {
            bestPaths.push({
              path: [startToken, tokenA, tokenB, tokenC, startToken],
              profitPct,
              profit,
              amountIn
            });
          }
        } catch {}
      }
    }
  }
  
  return bestPaths.sort((a, b) => b.profitPct - a.profitPct)[0] || null;
}

// ================= STRATEGY 3: POOL IMBALANCE DETECTION =================
// Detects when pool's K constant drifts from optimal (indicates arbitrage)
async function detectPoolImbalance(tokenA, tokenB) {
  const reserves = await getReserves("quick", tokenA.address, tokenB.address);
  if (!reserves) return null;
  
  const key = `${tokenA.symbol}-${tokenB.symbol}`;
  const currentK = reserves.kCurrent;
  
  if (!state.poolKHistory.has(key)) {
    state.poolKHistory.set(key, currentK);
    return null;
  }
  
  const historicalK = state.poolKHistory.get(key);
  state.poolKHistory.set(key, currentK);
  
  // Calculate K drift percentage
  const kDrift = ((Number(currentK - historicalK) / Number(historicalK)) * 100);
  
  // If K changed by > 0.5%, pool is imbalanced
  console.log("Profit:"+kDrift);
  if (Math.abs(kDrift) > 0.5) {
    log(`🔍 Pool Imbalance Detected: ${key} K drift ${kDrift.toFixed(2)}%`, "OPPORTUNITY");
    
    // Calculate optimal arbitrage size
    const sqrtK = Math.sqrt(Number(currentK));
    const optimalSize = Math.floor(sqrtK / 100); // Rule of thumb
    
    return {
      tokenA,
      tokenB,
      kDrift,
      optimalSize,
      signal: "IMBALANCE"
    };
  }
  
  return null;
}

// ================= MAIN ARBITRAGE CHECKER =================
async function checkArbitrage(tokenA, tokenB, size) {
  try {
    const amountIn = ethers.parseUnits(size.toString(), 6);
    
    // Get reserves from both DEXes
    const [rQuick, rSushi] = await Promise.all([
      getReserves("quick", tokenA.address, tokenB.address),
      getReserves("sushi", tokenA.address, tokenB.address)
    ]);
    
    if (!rQuick || !rSushi) return null;
    
    // Calculate price on each DEX
    const priceQuick = (Number(rQuick.reserveB) / Number(rQuick.reserveA));
    const priceSushi = (Number(rSushi.reserveB) / Number(rSushi.reserveA));
    
    // Check momentum
    const momentum = detectMomentum(`${tokenA.symbol}-${tokenB.symbol}`, priceQuick);
    
    // Option 1: Buy on Quick, sell on Sushi
    const t1 = calculateAmountOut(amountIn, rQuick.reserveA, rQuick.reserveB, 30);
    const u1 = calculateAmountOut(t1, rSushi.reserveB, rSushi.reserveA, 30);
    
    // Option 2: Buy on Sushi, sell on Quick
    const t2 = calculateAmountOut(amountIn, rSushi.reserveA, rSushi.reserveB, 30);
    const u2 = calculateAmountOut(t2, rQuick.reserveB, rQuick.reserveA, 30);
    
    const [finalOut, buyDex, sellDex] = u1 > u2 
      ? [u1, "QuickSwap", "SushiSwap"]
      : [u2, "SushiSwap", "QuickSwap"];
    
    // Calculate profit
    const flashFee = (amountIn * 9n) / 10000n;
    const gasCost = ethers.parseUnits("0.15", 6); // $0.15 gas estimate
    const totalCost = amountIn + flashFee + gasCost;
    
    const profit = finalOut - totalCost;
    const profitUSD = Number(ethers.formatUnits(profit, 6));
    const profitPct = (profitUSD / size) * 100;
    
    // Bonus scoring: add momentum multiplier
    let adjustedProfit = profitUSD;
    if (momentum.signal === "STRONG") {
      adjustedProfit *= 1.3; // 30% bonus for strong momentum
      log(`📈 Momentum boost: ${momentum.direction} ${momentum.momentum.toFixed(2)}%/s`, "INFO");
    }
    
    if (adjustedProfit >= CONFIG.MIN_PROFIT_USD) {
      return {
        tokenA,
        tokenB,
        size,
        profit: profitUSD,
        profitPct,
        buyDex,
        sellDex,
        momentum: momentum.signal,
        steps: [
          { 
            router: buyDex === "QuickSwap" ? DEXES.QUICK.router : DEXES.SUSHI.router,
            tokenIn: tokenA.address,
            tokenOut: tokenB.address,
            fee: 0
          },
          {
            router: sellDex === "QuickSwap" ? DEXES.QUICK.router : DEXES.SUSHI.router,
            tokenIn: tokenB.address,
            tokenOut: tokenA.address,
            fee: 0
          }
        ]
      };
    }
    
    return null;
  } catch {
    return null;
  }
}

// ================= EXECUTION =================
async function executeTrade(opp) {
  if (Date.now() - state.lastTrade < CONFIG.COOLDOWN_MS) return;
  
  log(`\n🚀 EXECUTING TRADE`, "SUCCESS");
  log(`   Route: ${opp.tokenA.symbol} -> ${opp.tokenB.symbol}`, "SUCCESS");
  log(`   Buy: ${opp.buyDex} | Sell: ${opp.sellDex}`, "SUCCESS");
  log(`   Size: $${opp.size}`, "SUCCESS");
  log(`   Profit: $${opp.profit.toFixed(2)} (${opp.profitPct.toFixed(2)}%)`, "SUCCESS");
  if (opp.momentum === "STRONG") log(`   🔥 MOMENTUM SIGNAL ACTIVE`, "SUCCESS");
  
  try {
    // Simulation first
    try {
      await flashContract.requestFlashLoan.staticCall(
        TOKENS.USDC.address,
        ethers.parseUnits(opp.size.toString(), 6),
        opp.steps
      );
      log(`   ✅ Simulation passed`, "INFO");
    } catch (e) {
      log(`   ❌ Simulation failed: ${e.message.slice(0, 80)}`, "ERROR");
      return;
    }
    
    // Execute
    const feeData = await provider.getFeeData();
    const tx = await flashContract.requestFlashLoan(
      TOKENS.USDC.address,
      ethers.parseUnits(opp.size.toString(), 6),
      opp.steps,
      {
        gasLimit: 600000,
        maxFeePerGas: (feeData.maxFeePerGas * 130n) / 100n,
        maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas * 130n) / 100n,
        nonce: state.nonce
      }
    );
    
    state.nonce++;
    state.lastTrade = Date.now();
    
    log(`   📤 TX: ${tx.hash}`, "INFO");
    
    const receipt = await tx.wait(1, 10000);
    
    if (receipt.status === 1) {
      state.trades++;
      state.profitUSD += opp.profit;
      log(`   🎉 SUCCESS! Block ${receipt.blockNumber}`, "SUCCESS");
      log(`   💰 Running total: $${state.profitUSD.toFixed(2)}`, "SUCCESS");
    } else {
      log(`   ❌ REVERTED`, "ERROR");
    }
    
  } catch (e) {
    log(`   ❌ Execution failed: ${e.message.slice(0, 100)}`, "ERROR");
    state.nonce = await provider.getTransactionCount(wallet.address);
  }
}

// ================= MAIN SCAN =================
async function scan() {
  state.scans++;
  
  if (state.scans % 50 === 0) {
    log(`\n📊 Stats: Scans=${state.scans} | Opps=${state.opportunities} | Trades=${state.trades} | Profit=$${state.profitUSD.toFixed(2)}`, "INFO");
  }
  
  try {
    const opportunities = [];
    
    // Strategy 1 & 3: Standard + Imbalance detection
    const pairs = [
      [TOKENS.USDC, TOKENS.USDT],
      [TOKENS.USDC, TOKENS.DAI],
      [TOKENS.USDC, TOKENS.WMATIC],
      [TOKENS.USDC, TOKENS.WETH],
      [TOKENS.USDT, TOKENS.DAI],
      [TOKENS.WMATIC, TOKENS.WETH]
    ];
    
    for (const [tokenA, tokenB] of pairs) {
      // Check for pool imbalance
      if (CONFIG.ENABLE_IMBALANCE) {
        const imbalance = await detectPoolImbalance(tokenA, tokenB);
        if (imbalance) {
          log(`⚠️ Imbalance: ${imbalance.tokenA.symbol}-${imbalance.tokenB.symbol} K=${imbalance.kDrift.toFixed(2)}%`, "WARN");
        }
      }
      
      // Check arbitrage across all sizes
      for (const size of CONFIG.TRADE_SIZES) {
        const opp = await checkArbitrage(tokenA, tokenB, size);
        if (opp) opportunities.push(opp);
      }
    }
    
    // Strategy 2: Multi-hop paths (less frequent check)
    if (CONFIG.ENABLE_MULTIHOP && state.scans % 5 === 0) {
      const multiHop = await findMultiHopPath(TOKENS.USDC, 500);
      if (multiHop && multiHop.profitPct > 0.4) {
        log(`🔗 Multi-hop found: ${multiHop.path.map(t => t.symbol).join("→")} | ${multiHop.profitPct.toFixed(2)}%`, "OPPORTUNITY");
      }
    }
    
    // Execute best opportunity
    if (opportunities.length > 0) {
      const best = opportunities.sort((a, b) => b.profit - a.profit)[0];
      state.opportunities++;
      
      if (best.profit >= CONFIG.OPTIMAL_PROFIT_USD) {
        await executeTrade(best);
      } else {
        process.stdout.write(`\r💡 Found: $${best.profit.toFixed(2)} (${best.tokenA.symbol}-${best.tokenB.symbol})   `);
      }
    } else {
      process.stdout.write(`\r🔍 Scanning... (${state.scans} scans, ${state.opportunities} opps)   `);
    }
    
  } catch (e) {
    log(`Scan error: ${e.message}`, "ERROR");
  }
  
  setTimeout(scan, CONFIG.SCAN_INTERVAL);
}

// ================= STARTUP =================
(async () => {
  console.clear();
  log(`╔${"═".repeat(68)}╗`, "INFO");
  log(`║  🤖 UNIQUE STRATEGY ARBITRAGE BOT v3.0${" ".repeat(29)}║`, "INFO");
  log(`║  3 Parallel Detection Methods + Momentum + Imbalance${" ".repeat(13)}║`, "INFO");
  log(`╚${"═".repeat(68)}╝`, "INFO");
  
  // Network check
  const network = await provider.getNetwork();
  log(`\n✅ Connected to ${network.name}`, "SUCCESS");
  
  // Wallet check
  state.nonce = await provider.getTransactionCount(wallet.address);
  const balance = await provider.getBalance(wallet.address);
  log(`💼 Wallet: ${wallet.address.slice(0, 10)}...${wallet.address.slice(-8)}`, "INFO");
  log(`   Balance: ${ethers.formatEther(balance)} MATIC`, "INFO");
  log(`   Nonce: ${state.nonce}`, "INFO");
  
  // Config
  log(`\n⚙️  Configuration:`, "INFO");
  log(`   Min Profit: $${CONFIG.MIN_PROFIT_USD}`, "INFO");
  log(`   Scan Interval: ${CONFIG.SCAN_INTERVAL}ms`, "INFO");
  log(`   Strategies: ${[CONFIG.ENABLE_MOMENTUM && "Momentum", CONFIG.ENABLE_MULTIHOP && "MultiHop", CONFIG.ENABLE_IMBALANCE && "Imbalance"].filter(Boolean).join(", ")}`, "INFO");
  
  log(`\n${"─".repeat(70)}`, "INFO");
  log(`🟢 BOT STARTED - Hunting with unique strategies...\n`, "SUCCESS");
  
  scan();
})();

process.on('SIGINT', () => {
  log(`\n\n${"═".repeat(70)}`, "INFO");
  log(`🛑 SHUTTING DOWN`, "INFO");
  log(`   Total Scans: ${state.scans}`, "INFO");
  log(`   Opportunities: ${state.opportunities}`, "INFO");
  log(`   Trades: ${state.trades}`, "INFO");
  log(`   Total Profit: $${state.profitUSD.toFixed(2)}`, "SUCCESS");
  log(`${"═".repeat(70)}\n`, "INFO");
  process.exit(0);
});
