// ===============================
// IMPORTS
// ===============================
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");

// ===============================
// ENV
// ===============================
const TOKEN = process.env.TELEGRAM_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!TOKEN || !WEBHOOK_URL) {
  throw new Error("Missing TELEGRAM_TOKEN or WEBHOOK_URL");
}

// ===============================
// INIT
// ===============================
const bot = new TelegramBot(TOKEN);
const app = express();
app.use(express.json());

// ===============================
// WEBHOOK
// ===============================
bot.setWebHook(`${WEBHOOK_URL}/webhook`);

// ===============================
// USER BALANCES (TEMP)
// ===============================
const users = {};

// ===============================
// DEFAULT KEYBOARD
// ===============================
const defaultKeyboard = {
  reply_markup: {
    keyboard: [
      ["💰 Naira Wallet", "💵 ETH Wallet"],
      ["₿ BTC Wallet", "🌐 USDT Wallet"],
      ["🟣 SOL Wallet", "🔄 Swap Crypto"],
      ["🎁 Refer and Earn", "📊 View Rates"],
      ["ℹ️ How to Use"]
    ],
    resize_keyboard: true,
    persistent_keyboard: true
  }
};

// ===============================
// FETCH COINGECKO NGN RATES
// ===============================
async function fetchNgnRates() {
  try {
    const url =
      "https://api.coingecko.com/api/v3/simple/price?ids=tether,bitcoin,ethereum,solana&vs_currencies=ngn";
    const { data } = await axios.get(url);
    return {
      usdt: data.tether.ngn,
      btc: data.bitcoin.ngn,
      eth: data.ethereum.ngn,
      sol: data.solana.ngn
    };
  } catch (err) {
    console.error("CoinGecko error:", err.message);
    return null;
  }
}

// ===============================
// INIT USER
// ===============================
function initUser(userId) {
  if (!users[userId]) {
    users[userId] = {
      naira: 10000,
      usdt: 50,
      btc: 50,
      eth: 50,
      sol: 50
    };
  }
}

// ===============================
// MESSAGE HANDLER
// ===============================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  initUser(userId);

  if (text === "/start") {
    return bot.sendMessage(
      chatId,
      "👋 Welcome to Aerosoft Trade Bot",
      defaultKeyboard
    );
  }

  if (text === "📊 View Rates") {
    const rates = await fetchNgnRates();
    if (!rates) {
      return bot.sendMessage(chatId, "❌ Unable to fetch rates");
    }

    return bot.sendMessage(
      chatId,
      `📊 LIVE RATES (NGN)
USDT: ₦${rates.usdt}
BTC: ₦${rates.btc}
ETH: ₦${rates.eth}
SOL: ₦${rates.sol}`
    );
  }
}

// ===============================
// WEBHOOK ENDPOINT
// ===============================
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (body.message) await handleMessage(body.message);
    if (body.callback_query) {
      await bot.answerCallbackQuery(body.callback_query.id);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// ===============================
// HEALTH CHECK
// ===============================
app.get("/", (req, res) => {
  res.send("✅ Aerosoft Trade Bot running on Replit");
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Bot running on port", PORT);
});
