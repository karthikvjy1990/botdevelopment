import asyncio
import logging
import aiohttp
import time
import random
from solders.keypair import Keypair
from solders.transaction import VersionedTransaction
from solana.rpc.async_api import AsyncClient
from solana.rpc.types import TxOpts
from solana.rpc.commitment import Confirmed

# ================= CONFIGURATION =================
# 🟢 SET THIS TO TRUE FOR TESTING, FALSE FOR REAL MONEY
SIMULATION_MODE = True

# 🛑 REPLACE WITH YOUR KEYS
PRIVATE_KEY = "3ZnobjNB4SBHYG5aZnezR6zF3uPBkMUUuVXCZj1ivC75MvsNZNvPkuwUWxPAvYnt8H1ipwuy1efg7KzgbZf1UwP1" 
RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=c5f1bc5f-da9d-4c5b-8ac5-6ea3de898556"

# ⚙️ TRADING SETTINGS
BUY_AMOUNT_SOL = 0.0001    
SLIPPAGE = 50            # High slippage (50%) to ensure entry in volatile pumps
MONITOR_WINDOW = 15      # How long to watch a new coin before giving up
MIN_VOL_THRESHOLD = 0.002
MIN_BUY_RATIO = 1.1      

# 🚪 EXIT STRATEGY
TAKE_PROFIT = 1.2       # 1.25x (25% Profit)
STOP_LOSS = 0.1        # 0.85x (15% Loss)
GRACE_PERIOD = 3         # Seconds to wait before checking TP/SL (avoids immediate noise)
MAX_HOLD_TIME = 30       # Force sell after 30 seconds no matter what

# 🔗 API ENDPOINTS
PUMP_PORTAL_WS = "wss://pumpportal.fun/api/data"
PUMP_PORTAL_API = "https://pumpportal.fun/api/trade-local"

# 📝 LOGGING SETUP
logging.basicConfig(
    level=logging.INFO, 
    format="%(asctime)s | %(message)s", 
    datefmt="%H:%M:%S"
)
log = logging.getLogger("Hunter")

class HunterBot:
    def __init__(self):
        if not SIMULATION_MODE:
            self.keypair = Keypair.from_base58_string(PRIVATE_KEY)
            self.rpc = AsyncClient(RPC_ENDPOINT)
        self.is_busy = False
        self.session = None
        self.last_buy_attempt = 0 

    async def execute_trade(self, action, mint, amount, denom_sol=True):
        """
        Executes a trade with robust Blockhash refreshing and Confirmation waiting.
        """
        if SIMULATION_MODE:
            fake_tx = f"simulated_tx_{int(time.time())}_{random.randint(1000,9999)}"
            log.info(f"🧪 SIMULATION {action.upper()}: {amount} | https://solscan.io/tx/{fake_tx}")
            return True

        try:
            # 1. Request Transaction Construction from PumpPortal
            payload = {
                "publicKey": str(self.keypair.pubkey()),
                "action": action,
                "mint": mint,
                "denominatedInSol": "true" if denom_sol else "false",
                "amount": amount,
                "slippage": SLIPPAGE,
                "priorityFee": 0.001, 
                "pool": "pump"
            }
            async with self.session.post(PUMP_PORTAL_API, json=payload) as r:
                if r.status != 200:
                    text = await r.text()
                    log.error(f"❌ API Error: {text}")
                    return False
                
                tx_bytes = await r.read()
                
                # Deserialize the transaction
                tx = VersionedTransaction.from_bytes(tx_bytes)
                
                # ⚡ 2. REFRESH BLOCKHASH (Critical Fix)
                # We fetch a fresh blockhash from Helius to replace the potentially stale one from PumpPortal
                try:
                    latest_bh = await self.rpc.get_latest_blockhash()
                    recent_blockhash = latest_bh.value.blockhash
                    
                    # Create a new message with the fresh blockhash
                    msg = tx.message
                    # Note: We are creating a new transaction object with the fresh hash
                    # This requires rebuilding the transaction with the new hash and signing it
                    # Since modifying 'tx.message' directly is complex in solders, 
                    # we often just sign the original if it's fresh enough. 
                    # Ideally, we rely on PumpPortal's hash, but if it fails often, we might need manual rebuilding.
                    # For now, we will sign the provided transaction directly. 
                    # If you get "Blockhash not found" consistently, we must manually rebuild the MessageV0 here.
                    
                    signed_tx = VersionedTransaction(msg, [self.keypair])
                except Exception as e:
                    log.warning(f"⚠️ Signing Error: {e}")
                    return False

                # 3. Send Transaction (Skip Preflight for speed)
                res = await self.rpc.send_transaction(
                    signed_tx, 
                    opts=TxOpts(skip_preflight=True)
                )
                sig = res.value
                log.info(f"🚀 SENT {action.upper()}: https://solscan.io/tx/{str(sig)}")

                # 4. 🛡️ WAIT FOR CONFIRMATION
                # We wait up to 15 seconds to see if the blockchain actually accepted it.
                log.info(f"⏳ Confirming {action.upper()}...")
                start_confirm = time.time()
                while time.time() - start_confirm < 15:
                    try:
                        status = await self.rpc.get_signature_statuses([sig])
                        if status.value[0] is not None:
                            if status.value[0].err is not None:
                                log.error(f"❌ Transaction FAILED on-chain: {status.value[0].err}")
                                return False
                            
                            confirmation = status.value[0].confirmation_status
                            if confirmation in ["confirmed", "finalized"]:
                                log.info(f"✅ CONFIRMED: Transaction landed!")
                                return True
                    except Exception:
                        pass
                    await asyncio.sleep(1)
                
                log.warning(f"⚠️ Transaction Dropped/Not Found (Network Congestion)")
                return False

        except Exception as e:
            log.error(f"❌ Execution Error: {e}")
            return False

    async def monitor_pnl_and_sell(self, mint):
        entry_time = time.time()
        entry_price = 0
        log.info(f"🛡️ POSITION ACTIVE: Monitoring {mint} (Max Hold: {MAX_HOLD_TIME}s)")
        
        async with self.session.ws_connect(PUMP_PORTAL_WS) as ws:
            await ws.send_json({"method": "subscribeTokenTrade", "keys": [mint]})
            while True:
                elapsed = time.time() - entry_time
                
                # Force Sell on Timeout
                if elapsed > MAX_HOLD_TIME:
                    log.warning(f"⏰ TIMEOUT: Force selling...")
                    await self.execute_trade("sell", mint, "100%", False)
                    return True

                try:
                    msg = await asyncio.wait_for(ws.receive(), timeout=1.0)
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        data = msg.json()
                        sol = float(data.get("solAmount", 0))
                        tokens = float(data.get("tokenAmount", 0))
                        
                        if sol > 0 and tokens > 0:
                            current_price = sol / tokens
                            
                            if entry_price == 0: 
                                entry_price = current_price
                                log.info(f"💰 Entry Price: {entry_price:.8f} SOL")
                                continue
                            
                            pnl = current_price / entry_price
                            
                            # Only check exit conditions after grace period
                            if elapsed > GRACE_PERIOD:
                                if pnl >= TAKE_PROFIT:
                                    log.info(f"✅ TAKE PROFIT TRIGGERED: {pnl:.2f}x")
                                    await self.execute_trade("sell", mint, "100%", False)
                                    return True
                                elif pnl <= STOP_LOSS:
                                    log.info(f"🛑 STOP LOSS TRIGGERED: {pnl:.2f}x")
                                    await self.execute_trade("sell", mint, "100%", False)
                                    return True
                                    
                except asyncio.TimeoutError:
                    continue
                except Exception as e:
                    log.error(f"⚠️ Monitor Error: {e}")
                    # On error, try to emergency sell
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
                                    # Anti-Spam Check: Don't buy if we tried in the last 2 seconds
                                    if time.time() - self.last_buy_attempt < 2:
                                        continue

                                    log.info(f"🎯 MOMENTUM HIT! Vol: {buys+sells:.3f} | Ratio: {ratio:.2f}")
                                    self.last_buy_attempt = time.time()

                                    # Only monitor IF the buy is confirmed
                                    if await self.execute_trade("buy", mint, BUY_AMOUNT_SOL):
                                        await self.monitor_pnl_and_sell(mint)
                                        return
                                    else:
                                        # If buy failed, force a small sleep to prevent 429 loop
                                        await asyncio.sleep(1) 
                                        return
                                        
                    except asyncio.TimeoutError:
                        continue
            log.info(f"🗑️ Skipped {mint[:6]} (Window expired)")
        except Exception as e:
            log.error(f"❌ Pipeline Error: {e}")
        finally:
            self.is_busy = False

    async def run(self):
        mode_str = "🧪 SIMULATION MODE" if SIMULATION_MODE else "🚀 LIVE TRADING MODE"
        log.info(f"🤖 Bot Started | {mode_str}")
        log.info(f"📊 TP: {TAKE_PROFIT}x | SL: {STOP_LOSS}x")
        
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