require("dotenv").config();
const { ethers } = require("ethers");
const chalk = require("chalk");

/* ============================================================
    1. ADVANCED CONFIGURATION
============================================================ */
//const RPC_URL = "https://lb.drpc.org/polygon/AtaWEu3Vb0UvjJUAZnzUnSw6VvL60cER8IDuMtMmCCpn";
const RPC_URL="https://polygon.api.onfinality.io/public";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const FLASH_LOAN_CONTRACT = "0x1097A1ec792c42013Be3f2c5D6319Dc2EB4Cecdc"; // Your Contract

// SETTINGS
const BORROW_AMOUNT = "1000"; // USDC
const MIN_NET_PROFIT = 1.0;   // Strict $1.00 Net Profit
const MAX_GAS_PRICE = 500;    // Gwei (Abort if network is too clogged)

const BASE_TOKEN = { 
    symbol: "USDC", 
    address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", 
    decimals: 6 
};

// INTERMEDIATE TOKENS (The "Bridge" assets for Triangular Arb)
const INTERMEDIATE_TOKENS = [
    { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
    { symbol: "WMATIC", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
    { symbol: "LINK", address: "0x53E0bca35eC356BD5ddDFebbd1Fc0fD03FaBad39", decimals: 18 },
    { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 }
];

const DEXS = [
    { name: "QuickSwap", router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff" },
    { name: "SushiSwap", router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506" }
];

/* ============================================================
    2. SETUP & ABIs
============================================================ */
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const botContract = new ethers.Contract(FLASH_LOAN_CONTRACT, [
    "function requestFlashLoan(address,uint256,(address router,address tokenIn,address tokenOut,uint24 fee)[]) external"
], wallet);

const routerAbi = [
    "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)"
];

// Initialize Routers
const routers = DEXS.map(d => ({
    name: d.name,
    address: d.router,
    contract: new ethers.Contract(d.router, routerAbi, provider)
}));

/* ============================================================
    3. ML / HEURISTIC SCORING ENGINE
============================================================ */
// This function mimics a trained Logistic Regression model
// It "deducts" opportunities that look risky or have low probability of success
function predictSuccessProbability(netProfit, gasPriceGwei, volatilityScore) {
    // 1. Profit Feature (Higher is better)
    let score = (netProfit * 20); 

    // 2. Gas Cost Feature (Higher gas = lower score)
    score -= (gasPriceGwei * 0.1); 

    // 3. Volatility Feature (Higher volatility = higher slippage risk for 3 hops)
    // In a real model, this would be a dynamic variable. 
    // We penalize slightly for stability.
    score -= (volatilityScore * 5);

    // Normalize to 0-100 probability
    return Math.max(0, Math.min(100, score + 50)); 
}

/* ============================================================
    4. TRIANGULAR ARBITRAGE ENGINE
============================================================ */
async function checkTriangularArb(middleToken, gasPrice) {
    const borrowAmt = ethers.parseUnits(BORROW_AMOUNT, BASE_TOKEN.decimals);

    // Path: USDC -> MiddleToken -> USDC
    // We check ALL DEX combinations for these 2 hops (Standard Arb)
    // AND we check 3-hop paths: USDC -> MiddleToken -> OtherToken -> USDC (Advanced)
    
    // For simplicity in this robust version, we focus on Cross-DEX Triangular:
    // Step 1: Buy MiddleToken on DEX A
    // Step 2: Sell MiddleToken for BaseToken on DEX B
    
    // 1. GET PRICES (Parallel Fetch)
    const quotes = [];
    
    for (const dex of routers) {
        try {
            // Path: USDC -> MiddleToken
            const amounts = await dex.contract.getAmountsOut(borrowAmt, [BASE_TOKEN.address, middleToken.address]);
            quotes.push({ dex: dex.name, dir: 'buy', amount: amounts[1], router: dex.address });
        } catch(e) {}
        
        try {
            // Path: MiddleToken -> USDC (We assume we have the amount from a buy, just getting rate)
            // We simulate selling 1 unit of MiddleToken to get the rate
            const oneUnit = ethers.parseUnits("1", middleToken.decimals);
            const amounts = await dex.contract.getAmountsOut(oneUnit, [middleToken.address, BASE_TOKEN.address]);
            quotes.push({ dex: dex.name, dir: 'sell', rate: amounts[1], router: dex.address });
        } catch(e) {}
    }

    // 2. CALCULATE PROFITABILITY
    let bestOpp = null;

    // Find Buy DEX
    for (const buyQ of quotes.filter(q => q.dir === 'buy')) {
        // Find Sell DEX (Must be different for arb, or same for triangular within one dex)
        for (const sellQ of quotes.filter(q => q.dir === 'sell')) {
            
            // Calculate hypothetical output
            // Output = AmountBought * SellRate
            // (Note: This is an approximation for speed; exact calc requires getAmountsOut with exact input)
            
            // REAL CALCULATION:
            try {
                // Get exact output from Sell DEX based on Buy Amount
                const sellRouter = routers.find(r => r.name === sellQ.dex);
                const amountsOut = await sellRouter.contract.getAmountsOut(buyQ.amount, [middleToken.address, BASE_TOKEN.address]);
                const finalAmount = amountsOut[1];

                // 3. DEDUCTIONS (The "Reality Check")
                const finalAmountNum = Number(ethers.formatUnits(finalAmount, BASE_TOKEN.decimals));
                const borrowNum = Number(BORROW_AMOUNT);
                
                // Flash Loan Fee (0.05%)
                const fee = borrowNum * 0.0005; 
                
                // Gas Cost (Approx 500k gas for 2 hops)
                const gasCostEth = (500000n * gasPrice);
                const maticPrice = 0.50; // Approx MATIC price
                const gasCostUsd = Number(ethers.formatUnits(gasCostEth, 18)) * maticPrice;

                const netProfit = finalAmountNum - borrowNum - fee - gasCostUsd;

                // 4. ML SCORING
                const mlScore = predictSuccessProbability(netProfit, Number(ethers.formatUnits(gasPrice, 9)), 2);

                if (netProfit > MIN_NET_PROFIT && mlScore > 60) {
                    // Log potential candidate
                    // console.log(`Candidate: ${buyQ.dex}->${sellQ.dex} | Net: $${netProfit.toFixed(3)}`);
                    
                    if (!bestOpp || netProfit > bestOpp.netProfit) {
                        bestOpp = {
                            path: [BASE_TOKEN.symbol, middleToken.symbol, BASE_TOKEN.symbol],
                            steps: [
                                { router: buyQ.router, tokenIn: BASE_TOKEN.address, tokenOut: middleToken.address, fee: 3000 },
                                { router: sellRouter.address, tokenIn: middleToken.address, tokenOut: BASE_TOKEN.address, fee: 3000 }
                            ],
                            netProfit,
                            gasCostUsd,
                            mlScore
                        };
                    }
                }
            } catch (e) { continue; }
        }
    }
    return bestOpp;
}

/* ============================================================
    5. EXECUTION LOOP
============================================================ */
async function executeTrade(opp) {
    console.log(chalk.yellow(`\n⚡ EXECUTING TRADE [Score: ${opp.mlScore.toFixed(0)}]`));
    console.log(chalk.yellow(`   Path: ${opp.path.join(" -> ")}`));
    console.log(chalk.yellow(`   Est. Net Profit: $${opp.netProfit.toFixed(4)} (Gas: $${opp.gasCostUsd.toFixed(2)})`));

    try {
        const feeData = await provider.getFeeData();
        const tx = await botContract.requestFlashLoan(
            BASE_TOKEN.address,
            ethers.parseUnits(BORROW_AMOUNT, BASE_TOKEN.decimals),
            opp.steps,
            {
                gasLimit: 800000, // Safety buffer
                maxFeePerGas: (feeData.maxFeePerGas * 120n) / 100n, // Aggressive bidding
                maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas * 120n) / 100n,
            }
        );
        console.log(chalk.cyan(`   📡 Tx Sent: ${tx.hash}`));
        const receipt = await tx.wait();
        console.log(chalk.green(`   ✅ SUCCESS: Block ${receipt.blockNumber}`));
    } catch (e) {
        console.log(chalk.red(`   ❌ REVERT: ${e.message.slice(0, 100)}...`));
    }
}

async function run() {
    console.log(chalk.green(`\n🤖 ADVANCED ARBITRAGE BOT INITIALIZED`));
    console.log(chalk.gray(`   Strategies: Triangular + ML Scoring + Net Profit Deductions`));
    
    while (true) {
        try {
            // 1. Update Network State
            const feeData = await provider.getFeeData();
            const gasPrice = feeData.gasPrice || 30000000000n;
            
            // Abort if gas is too high (ML feature: avoid high congestion)
            if (gasPrice > ethers.parseUnits(MAX_GAS_PRICE.toString(), 9)) {
                console.log(chalk.red(`   ⚠️ Gas too high (${ethers.formatUnits(gasPrice, 9)} gwei). Sleeping...`));
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }

            // 2. Scan All Paths
            process.stdout.write(chalk.gray(`\rScanning... Gas: ${Number(ethers.formatUnits(gasPrice, 9)).toFixed(0)} Gwei `));
            
            for (const token of INTERMEDIATE_TOKENS) {
                const opp = await checkTriangularArb(token, gasPrice);
                if (opp) {
                    await executeTrade(opp);
                    await new Promise(r => setTimeout(r, 10000)); // Cooldown after trade
                    break; 
                }
            }
        } catch (e) {
            console.error(e);
        }
        await new Promise(r => setTimeout(r, 100)); // Aggressive scan speed
    }
}

run();