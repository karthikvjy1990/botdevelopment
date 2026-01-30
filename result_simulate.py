import asyncio
import logging
import aiohttp
import time
from solders.keypair import Keypair
from solders.transaction import VersionedTransaction
from solana.rpc.async_api import AsyncClient
from solana.rpc.types import TxOpts

# ================= CONFIGURATION =================
PRIVATE_KEY = "3ZnobjNB4SBHYG5aZnezR6zF3uPBkMUUuVXCZj1ivC75MvsNZNvPkuwUWxPAvYnt8H1ipwuy1efg7KzgbZf1UwP1" 
RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=c5f1bc5f-da9d-4c5b-8ac5-6ea3de898556"

BUY_AMOUNT_SOL = 0.0001    
SLIPPAGE = 25            
MONITOR_WINDOW = 15      
MIN_VOL_THRESHOLD = 0.002
MIN_BUY_RATIO = 1.1      

# EXITS
TAKE_PROFIT = 1.00       # 1.00x (Breakeven - change to 1.25 for 25%)
STOP_LOSS = 0.10         # 0.90x (Change to 0.85 for 15% loss)
GRACE_PERIOD = 3         
MAX_HOLD_TIME = 30       # Force sell after 1 minute of no activity/exit

PUMP_PORTAL_WS = "wss://pumpportal.fun/api/data"
PUMP_PORTAL_API = "https://pumpportal.fun/api/trade-local"

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("Hunter")

class HunterBot:
    def __init__(self):
        self.keypair = Keypair.from_base58_string(PRIVATE_KEY)
        self.rpc = AsyncClient(RPC_ENDPOINT)
        self.is_busy = False
        self.session = None

    async def execute_trade(self, action, mint, amount, denom_sol=True):
        try:
            payload = {
                "publicKey": str(self.keypair.pubkey()),
                "action": action,
                "mint": mint,
                "denominatedInSol": "true" if denom_sol else "false",
                "amount": amount,
                "slippage": SLIPPAGE,
                "priorityFee": 0.005,
                "pool": "pump"
            }
            async with self.session.post(PUMP_PORTAL_API, json=payload) as r:
                if r.status != 200:
                    log.error(f"❌ API Error: {await r.text()}")
                    return False
                
                tx_bytes = await r.read()
                tx = VersionedTransaction.from_bytes(tx_bytes)
                signed_tx = VersionedTransaction(tx.message, [self.keypair])
                
                res = await self.rpc.send_transaction(signed_tx, opts=TxOpts(skip_preflight=True))
                log.info(f"🚀 {action.upper()} SUCCESS: https://solscan.io/tx/{res.value}")
                return True
        except Exception as e:
            log.error(f"❌ {action.upper()} Failed: {e}")
            return False

    async def monitor_pnl_and_sell(self, mint):
        entry_time = time.time()
        entry_price = 0
        log.info(f"🛡️ POSITION ACTIVE: Monitoring {mint} (Max Hold: {MAX_HOLD_TIME}s)")
        
        async with self.session.ws_connect(PUMP_PORTAL_WS) as ws:
            await ws.send_json({"method": "subscribeTokenTrade", "keys": [mint]})
            
            while True:
                elapsed = time.time() - entry_time
                
                # Check for Force Sell Timeout
                if elapsed > MAX_HOLD_TIME:
                    log.warning(f"⏰ TIMEOUT: No exit hit within {MAX_HOLD_TIME}s. Force selling...")
                    await self.execute_trade("sell", mint, "100%", False)
                    return True

                try:
                    # Timeout the receive so we can loop back and check the MAX_HOLD_TIME
                    msg = await asyncio.wait_for(ws.receive(), timeout=1.0)
                    
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        data = msg.json()
                        sol = float(data.get("solAmount", 0))
                        tokens = float(data.get("tokenAmount", 0))
                        
                        if sol > 0 and tokens > 0:
                            current_price = sol / tokens
                            
                            if entry_price == 0: 
                                entry_price = current_price
                                log.info(f"💰 Entry Price Set: {entry_price:.10f}")
                                continue
                            
                            pnl = current_price / entry_price
                            
                            if elapsed > GRACE_PERIOD:
                                if pnl >= TAKE_PROFIT or pnl <= STOP_LOSS:
                                    result = "PROFIT" if pnl >= TAKE_PROFIT else "LOSS"
                                    log.info(f"🚨 {result} TRIGGER: {pnl:.2f}x. Executing Sell...")
                                    if await self.execute_trade("sell", mint, "100%", False):
                                        log.info(f"✅ Trade Finished.\n" + "-"*40)
                                        return True
                except asyncio.TimeoutError:
                    continue
                except Exception as e:
                    log.error(f"⚠️ Monitoring Loop Error: {e}")
                    # Attempt safe exit on crash
                    await self.execute_trade("sell", mint, "100%", False)
                    return False

    async def process_pipeline(self, mint):
        self.is_busy = True
        try:
            start_time = time.time()
            buys = sells = 0.0
            log.info(f"🔎 Scanning: {mint}...")
            
            async with self.session.ws_connect(PUMP_PORTAL_WS) as ws:
                await ws.send_json({"method": "subscribeTokenTrade", "keys": [mint]})
                while time.time() - start_time < MONITOR_WINDOW:
                    try:
                        msg = await asyncio.wait_for(ws.receive_json(), timeout=0.5)
                        if msg.get("mint") == mint:
                            val = float(msg.get("solAmount") or 0)
                            if val > 0:
                                if msg.get("txType") == "buy": buys += val
                                else: sells += val
                                
                                ratio = buys / (sells if sells > 0 else 0.01)
                                if (buys + sells) >= MIN_VOL_THRESHOLD and ratio >= MIN_BUY_RATIO:
                                    log.info(f"🎯 MOMENTUM HIT! Vol: {buys+sells:.3f} | Ratio: {ratio:.2f}")
                                    if await self.execute_trade("buy", mint, BUY_AMOUNT_SOL):
                                        await self.monitor_pnl_and_sell(mint)
                                        return
                    except asyncio.TimeoutError:
                        continue
            log.info(f"🗑️ Skipped {mint[:6]} (Window expired)")
        except Exception as e:
            log.error(f"❌ Pipeline Error: {e}")
        finally:
            self.is_busy = False

    async def run(self):
        log.info(f"🤖 Bot Started | TP: {TAKE_PROFIT}x | SL: {STOP_LOSS}x | Timeout: {MAX_HOLD_TIME}s")
        async with aiohttp.ClientSession() as session:
            self.session = session
            async with self.session.ws_connect(PUMP_PORTAL_WS) as ws:
                await ws.send_json({"method": "subscribeNewToken"})
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        data = msg.json()
                        if "mint" in data and not self.is_busy:
                            asyncio.create_task(self.process_pipeline(data["mint"]))

if __name__ == "__main__":
    try:
        asyncio.run(HunterBot().run())
    except KeyboardInterrupt:
        pass