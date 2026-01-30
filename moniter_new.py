import os
import sys
import time
import asyncio
import aiohttp
import logging
import random
from datetime import datetime
from dotenv import load_dotenv

# Solana Imports
from solders.keypair import Keypair
from solders.transaction import VersionedTransaction
from solana.rpc.async_api import AsyncClient
from solana.rpc.types import TxOpts

load_dotenv()

# ================= CONFIGURATION =================
SIMULATION_MODE = True  # Set to False for LIVE TRADING
BUY_AMOUNT_SOL = 0.01   # Amount to spend per trade
SLIPPAGE_BPS = 500      # 5% slippage

# Strategy Parameters
MIN_TRADES_FILTER = 10      # Required trades before buying
MIN_VOLUME_FILTER = 0.5     # Required SOL volume before buying
MOMENTUM_RATIO = 1.4        # Buy/Sell ratio (1.4 = 40% more buys than sells)
VALIDATION_WINDOW = 15      # Seconds to watch a new token

# Exit Strategy
TAKE_PROFIT = 1.5           # 1.5x (50% profit)
STOP_LOSS = 0.85            # 0.85x (15% loss)
MAX_HOLD_TIME = 300         # 5 minutes in seconds

# API Endpoints
PUMP_PORTAL_WS = "wss://pumpportal.fun/api/data"
PUMP_PORTAL_API = "https://pumpportal.fun/api/trade-local"

# ================= LOGGING SETUP =================
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    handlers=[logging.StreamHandler(), logging.FileHandler("bot_history.log")]
)
log = logging.getLogger("Sniper")

class Visuals:
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    GREEN = '\033[92m'
    RED = '\033[91m'
    END = '\033[0m'
    BOLD = '\033[1m'

# ================= SIMULATION ENGINE =================
class SimulationManager:
    def __init__(self):
        self.active_positions = {} # mint: entry_price
        
    def simulate_buy(self, mint, current_price):
        # Add 1% "virtual" slippage to be realistic
        entry = current_price * 1.01
        self.active_positions[mint] = entry
        return entry

    def simulate_sell(self, mint, current_price):
        entry = self.active_positions.pop(mint, None)
        if not entry: return 0, 0
        # Subtract 1% "virtual" slippage for sell
        exit_price = current_price * 0.99
        pnl_pct = (exit_price / entry - 1) * 100
        return exit_price, pnl_pct

# ================= THE BOT =================
class MoverBot:
    def __init__(self):
        self.session = None
        self.is_busy = False
        self.sim = SimulationManager()
        
        if not SIMULATION_MODE:
            pk = os.getenv("SOL_PRIVATE_KEY")
            if not pk: raise ValueError("SOL_PRIVATE_KEY missing in .env")
            self.keypair = Keypair.from_base58_string(pk)
            self.rpc = AsyncClient(os.getenv("RPC_ENDPOINT"))

    async def get_tx_result(self, action, mint, price, pnl=0):
        """Logs a formatted trade summary"""
        stamp = datetime.now().strftime("%H:%M:%S")
        mode = "🧪 [SIM]" if SIMULATION_MODE else "🚀 [LIVE]"
        
        if action == "BUY":
            log.info(f"{Visuals.BLUE}{mode} {stamp} | BUY  | {mint[:8]} | Entry: {price:.9f}{Visuals.END}")
        else:
            color = Visuals.GREEN if pnl > 0 else Visuals.RED
            log.info(f"{color}{mode} {stamp} | SELL | {mint[:8]} | Exit: {price:.9f} | PnL: {pnl:+.2f}%{Visuals.END}")

    async def execute_trade(self, action, mint, current_price, amount_sol=0):
        if SIMULATION_MODE:
            if action == "buy":
                entry = self.sim.simulate_buy(mint, current_price)
                await self.get_tx_result("BUY", mint, entry)
            else:
                exit_p, pnl = self.sim.simulate_sell(mint, current_price)
                await self.get_tx_result("SELL", mint, exit_p, pnl)
            return True

        # LIVE LOGIC (PumpPortal Local API)
        payload = {
            "publicKey": str(self.keypair.pubkey()),
            "action": action, "mint": mint,
            "denominatedInSol": "true",
            "amount": str(BUY_AMOUNT_SOL) if action == "buy" else "100%",
            "slippage": 10, "priorityFee": 0.001, "pool": "pump"
        }
        try:
            async with self.session.post(PUMP_PORTAL_API, json=payload) as r:
                if r.status != 200: return False
                tx_data = await r.read()
                tx = VersionedTransaction.from_bytes(tx_data)
                signed = VersionedTransaction(tx.message, [self.keypair])
                res = await self.rpc.send_transaction(signed, opts=TxOpts(skip_preflight=True))
                log.info(f"✅ TX Sent: https://solscan.io/tx/{res.value}")
                return True
        except Exception as e:
            log.error(f"Trade Error: {e}")
            return False

    async def monitor_and_sell(self, mint, entry_price):
        start_time = time.time()
        
        async with self.session.ws_connect(PUMP_PORTAL_WS) as ws:
            await ws.send_json({"method": "subscribeTokenTrade", "keys": [mint]})
            
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT: continue
                data = msg.json()
                
                # Calculate current price from trade
                sol = float(data.get("solAmount", 0))
                tok = float(data.get("tokenAmount", 0))
                if sol <= 0 or tok <= 0: continue
                current_price = sol / tok
                
                pnl_ratio = current_price / entry_price
                elapsed = time.time() - start_time

                # Check Exits
                if pnl_ratio >= TAKE_PROFIT or pnl_ratio <= STOP_LOSS or elapsed > MAX_HOLD_TIME:
                    reason = "TP" if pnl_ratio >= TAKE_PROFIT else "SL" if pnl_ratio <= STOP_LOSS else "TIME"
                    log.info(f"Triggering {reason} exit for {mint[:6]}...")
                    await self.execute_trade("sell", mint, current_price)
                    break

    async def process_mint(self, mint):
        if self.is_busy: return
        self.is_busy = True
        
        buys = sells = trades = 0
        start_time = time.time()
        first_price = 0

        try:
            async with self.session.ws_connect(PUMP_PORTAL_WS) as ws:
                await ws.send_json({"method": "subscribeTokenTrade", "keys": [mint]})
                
                while time.time() - start_time < VALIDATION_WINDOW:
                    try:
                        msg = await asyncio.wait_for(ws.receive(), timeout=0.5)
                        if msg.type != aiohttp.WSMsgType.TEXT: continue
                        data = msg.json()
                        
                        sol_val = float(data.get("solAmount") or 0)
                        if sol_val <= 0: continue

                        trades += 1
                        if first_price == 0: first_price = sol_val / float(data.get("tokenAmount"))
                        
                        if data.get("txType") == "buy": buys += sol_val
                        else: sells += sol_val

                        # VALIDATION LOGIC
                        ratio = buys / max(sells, 0.01)
                        if trades >= MIN_TRADES_FILTER and (buys+sells) >= MIN_VOLUME_FILTER and ratio >= MOMENTUM_RATIO:
                            log.info(f"🎯 SIGNAL FOUND: {mint[:6]} | Vol: {buys+sells:.2f} | Ratio: {ratio:.2f}")
                            if await self.execute_trade("buy", mint, first_price):
                                await self.monitor_and_sell(mint, first_price)
                                return 
                    except asyncio.TimeoutError: continue
        finally:
            self.is_busy = False

    async def run(self):
        log.info(f"{Visuals.BOLD}{Visuals.HEADER}=== SNIPER BOT STARTED (SIM={SIMULATION_MODE}) ==={Visuals.END}")
        async with aiohttp.ClientSession() as self.session:
            async with self.session.ws_connect(PUMP_PORTAL_WS) as ws:
                await ws.send_json({"method": "subscribeNewToken"})
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        data = msg.json()
                        if "mint" in data:
                            asyncio.create_task(self.process_mint(data["mint"]))

if __name__ == "__main__":
    try:
        asyncio.run(MoverBot().run())
    except KeyboardInterrupt:
        sys.exit()