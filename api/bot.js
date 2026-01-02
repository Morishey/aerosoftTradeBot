// ===============================
// IMPORTS
// ===============================
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// ===============================
// TELEGRAM TOKEN
// ===============================
const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) {
  throw new Error("Missing TELEGRAM_TOKEN environment variable");
}

// ===============================
// INITIALIZE BOT (NO WEBHOOK SET HERE)
// ===============================
const bot = new TelegramBot(TOKEN);

// ===============================
// USER BALANCES (TEMP – NOT PERSISTENT)
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
      ["ℹ️ How to Use"],
    ],
    resize_keyboard: true,
    persistent_keyboard: true,
  },
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
      sol: data.solana.ngn,
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
      sol: 50,
      waitingWithdrawal: false,
      waitingBankDetails: false,
      waitingBuySell: null,
      waitingSwap: false,
      swapType: null,
      selectedCrypto: null,
      bankAccount: null,
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
  const u = users[userId];

  if (text === "/start") {
    return bot.sendMessage(
      chatId,
      "👋 Welcome to Aerosoft Trade Bot",
      defaultKeyboard
    );
  }

  if (text === "📊 View Rates") {
    const rates = await fetchNgnRates();
    if (!rates) return bot.sendMessage(chatId, "❌ Unable to fetch rates");

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
// CALLBACK HANDLER
// ===============================
async function handleCallback(query) {
  await bot.answerCallbackQuery(query.id);
}

// ===============================
// VERCEL HANDLER (THIS IS WHAT MATTERS)
// ===============================
module.exports = async (req, res) => {
  try {
    if (req.method === "POST") {
      const body = req.body;

      if (body.message) await handleMessage(body.message);
      if (body.callback_query) await handleCallback(body.callback_query);

      return res.status(200).send("OK");
    }

    return res.status(200).send("Telegram bot webhook is running ✅");
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).send("Internal Error");
  }
};
