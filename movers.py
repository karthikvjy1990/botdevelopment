import asyncio
import aiohttp
import json
import logging
import sys
import time
from datetime import datetime

# ================= ⚙️ CONFIGURATION ⚙️ =================
CONFIG = {
    "BUY_AMOUNT_SOL": 0.001,
    "MIN_AGE_SECONDS": 120,       # Wait 2 Minutes
    "MAX_AGE_SECONDS": 14400,     # Max 4 Hours
    "MIN_BUY_RATIO": 1.5,         # Buy Pressure > 1.5x
    "TAKE_PROFIT_PCT": 20.0,
    "STOP_LOSS_PCT": -10.0
}

# ================= LOGGING =================
# Set up a clean logger that prints to console
logger = logging.getLogger("MoversBot")
logger.setLevel(logging.INFO)
handler = logging.StreamHandler(sys.stdout)
formatter = logging.Formatter('%(asctime)s | %(message)s', datefmt='%H:%M:%S')
handler.setFormatter(formatter)
logger.addHandler(handler)

# ================= TRACKER =================
class TokenData:
    def __init__(self, mint, start_time):
        self.mint = mint
        self.birth_time = start_time
        self.buy_vol = 0.0
        self.sell_vol = 0.0
        self.price = 0.0
        self.active_trade = False
        self.entry_price = 0.0
        self.last_log_time = 0

# ================= BOT LOGIC =================
class ChattyBot:
    def __init__(self):
        self.tracked = {}
        self.start_time = time.time()

    def get_age(self, token):
        return time.time() - token.birth_time

    # --- SIMULATE BUY ---
    def execute_buy(self, token):
        token.active_trade = True
        token.entry_price = token.price
        target = token.price * (1 + CONFIG['TAKE_PROFIT_PCT'] / 100)
        
        logger.info(f"🚀 [EXECUTE BUY] {token.mint}")
        logger.info(f"   ⏳ Age: {self.get_age(token):.1f}s | 💰 Price: {token.price:.8f}")
        logger.info(f"   🎯 Target: {target:.8f}")

    # --- SIMULATE SELL ---
    def execute_sell(self, token, reason):
        pnl = ((token.price - token.entry_price) / token.entry_price) * 100
        emoji = "💰" if pnl > 0 else "🛑"
        logger.info(f"{emoji} [SELL] {token.mint} | {reason} | PnL: {pnl:.2f}%")
        token.active_trade = False

    # --- PROCESS DATA ---
    async def process_msg(self, data):
        # 1. NEW TOKEN FOUND
        if "mint" in data and data.get("txType") == "create":
            mint = data["mint"]
            if mint not in self.tracked:
                self.tracked[mint] = TokenData(mint, time.time())
                logger.info(f"👀 FOUND NEW TOKEN: {mint} (Age: 0s) -> Tracking...")
            return

        # 2. TRADE DETECTED
        if "mint" in data and "txType" in data:
            mint = data["mint"]
            
            # If we missed the create event, add it now
            if mint not in self.tracked:
                self.tracked[mint] = TokenData(mint, time.time())
                logger.info(f"👀 FOUND TOKEN (VIA TRADE): {mint} -> Tracking...")
            
            token = self.tracked[mint]
            
            # Update Price & Volume
            try:
                sol = float(data.get("solAmount", 0))
                tok = float(data.get("tokenAmount", 0))
                if tok > 0: token.price = sol / tok
                
                if data["txType"] == "buy": token.buy_vol += sol
                elif data["txType"] == "sell": token.sell_vol += sol
            except:
                return

            # --- CHECK STRATEGY ---
            age = self.get_age(token)

            # A. Manage Active Trade
            if token.active_trade:
                pnl = ((token.price - token.entry_price) / token.entry_price) * 100
                if pnl >= CONFIG["TAKE_PROFIT_PCT"]: self.execute_sell(token, "TAKE PROFIT")
                elif pnl <= CONFIG["STOP_LOSS_PCT"]: self.execute_sell(token, "STOP LOSS")
                return

            # B. Check Entry Conditions
            
            # LOGGING: Print status every 30 seconds so you see it's waiting
            if age < CONFIG["MIN_AGE_SECONDS"]:
                if time.time() - token.last_log_time > 30:
                    logger.info(f"⏳ Waiting... {mint[:6]} is {age:.0f}s old (Need {CONFIG['MIN_AGE_SECONDS']}s)")
                    token.last_log_time = time.time()
                return

            # If Age is good, check ratio
            ratio = token.buy_vol / max(token.sell_vol, 0.0001)
            
            if ratio > CONFIG["MIN_BUY_RATIO"]:
                self.execute_buy(token)

    # --- MAIN LOOP ---
    async def run(self):
        logger.info("📡 CONNECTING TO PUMP.FUN...")
        logger.info(f"ℹ️  Will log 'Found New Token' immediately.")
        logger.info(f"ℹ️  Will buy after {CONFIG['MIN_AGE_SECONDS']} seconds.")

        async with aiohttp.ClientSession() as session:
            async with session.ws_connect("wss://pumpportal.fun/api/data") as ws:
                
                # Subscribe to New Tokens (to find them)
                await ws.send_json({"method": "subscribeNewToken"})
                
                last_ping = time.time()
                
                async for msg in ws:
                    # Heartbeat Log (Every 10s)
                    if time.time() - last_ping > 10:
                        count = len(self.tracked)
                        logger.info(f"💓 [HEARTBEAT] Still Listening... (Tracking {count} tokens)")
                        last_ping = time.time()

                    if msg.type == aiohttp.WSMsgType.TEXT:
                        data = json.loads(msg.data)
                        
                        # Subscribe to trades for any new token we find
                        if "mint" in data and "txType" not in data: # Creation event
                             await ws.send_json({"method": "subscribeTokenTrade", "keys": [data["mint"]]})
                        
                        await self.process_msg(data)

if __name__ == "__main__":
    if sys.platform.startswith("win"):
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    try:
        asyncio.run(ChattyBot().run())
    except KeyboardInterrupt:
        print("Bot Stopped")