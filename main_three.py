import asyncio
import json
import logging
import aiohttp
import os
import sys
import traceback
from dotenv import load_dotenv

from solders.keypair import Keypair
from solders.transaction import VersionedTransaction
from solders.signature import Signature

from solana.rpc.async_api import AsyncClient
from solana.rpc.types import TxOpts
from solana.rpc.commitment import Confirmed

# --- WINDOWS FIX ---
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    sys.stdout.reconfigure(encoding='utf-8') # Prevent emoji crash

load_dotenv()

PRIVATE_KEY = 'ag2C6yjvHVo8Dcc528UcxyBgRs7WxtbGkXWTvqTm1yEUCbCe2w8CVbEcWdG4aG1irZUoRSF1VPttnsc6Qra414C'
RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=c5f1bc5f-da9d-4c5b-8ac5-6ea3de898556'

# TRADING CONFIG
BUY_AMOUNT_SOL = 0.001  
SLIPPAGE = 30           # Increased for faster landing
PRIORITY_FEE = 0.001    # Tip for miners
HOLD_SECONDS = 300

PUMP_PORTAL_WS = "wss://pumpportal.fun/api/data"
PUMP_PORTAL_API = "https://pumpportal.fun/api/trade-local"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("Sniper")

class ProductionSniper:
    def __init__(self):
        if not PRIVATE_KEY or not RPC_URL:
            logger.error("❌ MISSING CONFIG: Check SOLANA_PRIVATE_KEY or RPC_URL in .env")
            sys.exit(1)
            
        self.keypair = Keypair.from_base58_string(PRIVATE_KEY)
        self.pubkey = str(self.keypair.pubkey())
        self.client = AsyncClient(RPC_URL, commitment=Confirmed)
        self.active_positions = set()

    async def check_balance(self):
        """Checks if wallet has enough SOL to trade"""
        bal = await self.client.get_balance(self.keypair.pubkey())
        sol_bal = bal.value / 10**9
        logger.info(f"💰 Wallet Balance: {sol_bal:.4f} SOL")
        if sol_bal < (BUY_AMOUNT_SOL + PRIORITY_FEE + 0.003):
            logger.warning("⚠️ BALANCE LOW: Buy might fail due to gas/rent.")

    async def verify_tx(self, sig_str: str) -> bool:
        """Wait for confirmation on explore"""
        try:
            sig = Signature.from_string(sig_str)
            for _ in range(20):
                await asyncio.sleep(1)
                res = await self.client.get_signature_statuses([sig])
                if res.value and res.value[0]:
                    if res.value[0].err is None:
                        return True
                    else:
                        logger.error(f"❌ TX FAILED ON-CHAIN: {res.value[0].err}")
                        return False
        except Exception as e:
            logger.error(f"Error verifying: {e}")
        return False

    # ---------------- EXECUTE BUY / SELL (NUCLEAR DEBUG VERSION) ----------------
    async def execute_trade(self, action: str, mint: str, amount):
        payload = {
            "publicKey": self.pubkey,
            "action": action,
            "mint": mint,
            "denominatedInSol": "true" if action == "buy" else "false",
            "amount": amount,
            "slippage": SLIPPAGE,
            "priorityFee": PRIORITY_FEE,
            "pool": "pump"
        }

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(PUMP_PORTAL_API, json=payload) as resp:
                    if resp.status != 200:
                        logger.error(f"❌ API REFUSED REQUEST [{resp.status}]: {await resp.text()}")
                        return None

                    tx_bytes = await resp.read()
                    unsigned_tx = VersionedTransaction.from_bytes(tx_bytes)
                    signed_tx = VersionedTransaction(unsigned_tx.message, [self.keypair])

                    # ATTEMPT SEND
                    try:
                        result = await self.client.send_raw_transaction(
                            bytes(signed_tx),
                            opts=TxOpts(skip_preflight=True)
                        )
                        sig = str(result.value)
                        logger.info(f"🚀 [{action.upper()} SENT] Sig: {sig}")
                        
                        if await self.verify_tx(sig):
                            logger.info(f"✅ [{action.upper()} CONFIRMED]")
                            return sig
                        return None

                    except Exception as e:
                        # --- NUCLEAR DEBUGGING ---
                        # This prints the raw dictionary of the error object
                        logger.error(f"❌ SEND FAILURE TYPE: {type(e).__name__}")
                        
                        # Check for RPC-specific error attributes
                        if hasattr(e, '__dict__'):
                            logger.error(f"❌ INTERNAL ERROR DATA: {e.__dict__}")
                        
                        # Check for response status if it's an HTTP error
                        if hasattr(e, 'status'):
                            logger.error(f"❌ HTTP STATUS: {e.status}")
                            
                        return None

        except Exception as e:
            logger.error(f"💥 CRITICAL ERROR: {repr(e)}")
            return None

    async def lifecycle(self, mint: str):
        if mint in self.active_positions: return
        self.active_positions.add(mint)
        
        # BUY
        sig = await self.execute_trade("buy", mint, BUY_AMOUNT_SOL)
        if not sig:
            self.active_positions.remove(mint)
            return

        # HOLD
        logger.info(f"⏳ Holding {mint[:8]} for {HOLD_SECONDS}s...")
        await asyncio.sleep(HOLD_SECONDS)

        # SELL
        await self.execute_trade("sell", mint, "100%")
        self.active_positions.remove(mint)

    async def start(self):
        await self.check_balance()
        logger.info(f"🤖 BOT STARTING | Listening for New Tokens...")
        
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(PUMP_PORTAL_WS) as ws:
                await ws.send_json({"method": "subscribeNewToken"})
                async for msg in ws:
                    data = json.loads(msg.data)
                    if "mint" in data:
                        mint = data["mint"]
                        logger.info(f"✨ NEW TOKEN DETECTED: {mint}")
                        asyncio.create_task(self.lifecycle(mint))

    async def run(self):
        while True:
            try:
                await self.start()
            except Exception as e:
                logger.error(f"Connection lost: {e}")
                await asyncio.sleep(5)

if __name__ == "__main__":
    bot = ProductionSniper()
    asyncio.run(bot.run())