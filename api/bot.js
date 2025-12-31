import TelegramBot from "node-telegram-bot-api";
import axios from "axios";

const TOKEN = process.env.TELEGRAM_TOKEN; // Telegram bot token
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://your-vercel-app.vercel.app

// Initialize bot without polling
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${WEBHOOK_URL}/api/bot`);

// In-memory user data (demo only)
const users = {};

// -------------------------------
// DEFAULT KEYBOARD
// -------------------------------
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

// -------------------------------
// FETCH COINGECKO NGN RATES
// -------------------------------
async function fetchNgnRates() {
  try {
    const url =
      "https://api.coingecko.com/api/v3/simple/price" +
      "?ids=tether,bitcoin,ethereum,solana" +
      "&vs_currencies=ngn";
    const { data } = await axios.get(url);
    return {
      usdt: data.tether.ngn,
      btc: data.bitcoin.ngn,
      eth: data.ethereum.ngn,
      sol: data.solana.ngn,
    };
  } catch (error) {
    console.error("CoinGecko fetch error:", error.message);
    return null;
  }
}

// -------------------------------
// INIT USER
// -------------------------------
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

// -------------------------------
// INLINE BUTTONS
// -------------------------------
function tradeButtons(asset) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🟢 Buy", callback_data: `buy_${asset}` },
          { text: "🔴 Sell", callback_data: `sell_${asset}` },
        ],
        [{ text: "❌ Cancel", callback_data: "cancel" }],
      ],
    },
  };
}

function withdrawButton() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🏦 Withdraw to Bank", callback_data: "withdraw_naira" }],
        [{ text: "❌ Cancel", callback_data: "cancel" }],
      ],
    },
  };
}

function swapTypeButtons() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💱 Naira → Crypto", callback_data: "swap_naira_to_crypto" },
          { text: "💱 Crypto → Naira", callback_data: "swap_crypto_to_naira" },
        ],
        [{ text: "❌ Cancel", callback_data: "cancel" }],
      ],
    },
  };
}

function cryptoSelectButtons(type) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🌐 USDT", callback_data: `${type}_usdt` },
          { text: "₿ BTC", callback_data: `${type}_btc` },
        ],
        [
          { text: "💵 ETH", callback_data: `${type}_eth` },
          { text: "🟣 SOL", callback_data: `${type}_sol` },
        ],
        [{ text: "❌ Cancel", callback_data: "cancel" }],
      ],
    },
  };
}

// -------------------------------
// START COMMAND
// -------------------------------
bot.onText(/\/start/, (msg) => {
  initUser(msg.from.id);
  bot.sendMessage(
    msg.chat.id,
    `🚀 <b>WELCOME TO AEROSOFT TRADE</b>\n\nSelect an option below`,
    { parse_mode: "HTML", ...defaultKeyboard }
  );
});

// -------------------------------
// MESSAGE HANDLER
// -------------------------------
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;
  initUser(userId);
  const u = users[userId];

  // BANK ACCOUNT ENTRY
  if (u.waitingBankDetails) {
    const parts = text.split("|");
    if (parts.length !== 2) {
      return bot.sendMessage(chatId, "❌ Invalid format. Use ACCOUNT_NUMBER|BANK_NAME\nExample: 0123456789|GT Bank");
    }
    u.bankAccount = { accountNumber: parts[0].trim(), bankName: parts[1].trim() };
    u.waitingBankDetails = false;
    u.waitingWithdrawal = true;
    return bot.sendMessage(chatId, "✅ Bank account saved!\nEnter withdrawal amount:", { parse_mode: "HTML" });
  }

  // NAIRA WITHDRAWAL INPUT
  if (u.waitingWithdrawal && u.waitingBuySell === "naira") {
    const amount = parseFloat(text.replace(/,/g, ""));
    if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "❌ Invalid amount");
    if (amount > u.naira) return bot.sendMessage(chatId, `❌ Balance too low to withdraw ₦${amount.toLocaleString()}`);
    u.naira -= amount;
    u.waitingWithdrawal = false;
    return bot.sendMessage(chatId, `✅ Withdrawal successful!\n₦${amount.toLocaleString()} sent to ${u.bankAccount.accountNumber} - ${u.bankAccount.bankName}`, { parse_mode: "HTML" });
  }

  // WALLET HANDLERS
  if (text === "💰 Naira Wallet") {
    if (u.naira <= 0) return bot.sendMessage(chatId, `💰 NAIRA WALLET\nBalance: ₦${u.naira.toLocaleString()}\n❌ Balance too low`, { parse_mode: "HTML" });
    return bot.sendMessage(chatId, `💰 NAIRA WALLET\nBalance: ₦${u.naira.toLocaleString()}`, { parse_mode: "HTML", ...withdrawButton() });
  }

  if (text === "🌐 USDT Wallet") return bot.sendMessage(chatId, `🌐 USDT WALLET\nBalance: ${u.usdt} USDT`, { parse_mode: "HTML", ...tradeButtons("usdt") });
  if (text === "₿ BTC Wallet") return bot.sendMessage(chatId, `₿ BTC WALLET\nBalance: ${u.btc} BTC`, { parse_mode: "HTML", ...tradeButtons("btc") });
  if (text === "💵 ETH Wallet") return bot.sendMessage(chatId, `💵 ETH WALLET\nBalance: ${u.eth} ETH`, { parse_mode: "HTML", ...tradeButtons("eth") });
  if (text === "🟣 SOL Wallet") return bot.sendMessage(chatId, `🟣 SOL WALLET\nBalance: ${u.sol} SOL`, { parse_mode: "HTML", ...tradeButtons("sol") });

  if (text === "🔄 Swap Crypto") return bot.sendMessage(chatId, "Select swap type", { parse_mode: "HTML", ...swapTypeButtons() });

  if (text === "📊 View Rates") {
    const rates = await fetchNgnRates();
    if (!rates) return bot.sendMessage(chatId, "❌ Unable to fetch rates. Try again.");
    return bot.sendMessage(chatId, `📊 LIVE CRYPTO RATES (NGN)\nUSDT - ₦${rates.usdt.toLocaleString()}\nBTC - ₦${rates.btc.toLocaleString()}\nETH - ₦${rates.eth.toLocaleString()}\nSOL - ₦${rates.sol.toLocaleString()}`, { parse_mode: "HTML" });
  }

  if (text === "ℹ️ How to Use") return bot.sendMessage(chatId, `ℹ️ HOW TO USE\n1️⃣ Wallets\n2️⃣ Buy/Sell crypto\n3️⃣ Withdraw Naira\n4️⃣ Swap crypto\n5️⃣ View rates`, { parse_mode: "HTML" });
});

// -------------------------------
// CALLBACK QUERY HANDLER
// -------------------------------
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;
  initUser(userId);
  const u = users[userId];
  const rates = await fetchNgnRates();
  bot.answerCallbackQuery(query.id);

  // CANCEL
  if (data === "cancel") {
    u.waitingWithdrawal = false;
    u.waitingBuySell = null;
    u.waitingBankDetails = false;
    u.waitingSwap = false;
    u.selectedCrypto = null;
    u.swapType = null;
    return bot.sendMessage(chatId, "❌ Operation cancelled", { parse_mode: "HTML" });
  }

  // NAIRA WITHDRAW
  if (data === "withdraw_naira") {
    if (u.naira <= 0) return bot.sendMessage(chatId, "❌ Balance too low", { parse_mode: "HTML" });
    if (!u.bankAccount) {
      u.waitingBankDetails = true;
      return bot.sendMessage(chatId, "🏦 Enter bank details ACCOUNT_NUMBER|BANK_NAME");
    }
    u.waitingWithdrawal = true;
    u.waitingBuySell = "naira";
    return bot.sendMessage(chatId, "🏦 Enter amount to withdraw:", { parse_mode: "HTML" });
  }

  // BUY/SELL CRYPTO
  if (data.startsWith("sell_")) {
    const asset = data.split("_")[1];
    if (u[asset] <= 0) return bot.sendMessage(chatId, `❌ Not enough ${asset.toUpperCase()}`, { parse_mode: "HTML" });
    const nairaValue = u[asset] * rates[asset];
    u.naira += nairaValue;
    u[asset] = 0;
    return bot.sendMessage(chatId, `✅ SOLD ${asset.toUpperCase()}\n₦${nairaValue.toLocaleString()} credited`, { parse_mode: "HTML" });
  }

  if (data.startsWith("buy_")) {
    const asset = data.split("_")[1];
    const cost = rates[asset];
    if (u.naira < cost) return bot.sendMessage(chatId, "❌ Insufficient Naira balance", { parse_mode: "HTML" });
    u.naira -= cost;
    u[asset] += 1;
    return bot.sendMessage(chatId, `✅ BOUGHT 1 ${asset.toUpperCase()}`, { parse_mode: "HTML" });
  }

  // SWAP TYPE SELECTION
  if (data === "swap_naira_to_crypto") {
    u.waitingSwap = true;
    u.swapType = "naira_to_crypto";
    return bot.sendMessage(chatId, "Select crypto to buy:", { parse_mode: "HTML", ...cryptoSelectButtons("buy") });
  }

  if (data === "swap_crypto_to_naira") {
    u.waitingSwap = true;
    u.swapType = "crypto_to_naira";
    return bot.sendMessage(chatId, "Select crypto to sell:", { parse_mode: "HTML", ...cryptoSelectButtons("sell") });
  }

  // CRYPTO SELECTION FOR SWAP
  if (data.startsWith("buy_") && u.waitingSwap && u.swapType === "naira_to_crypto") {
    u.selectedCrypto = data.split("_")[1];
    return bot.sendMessage(chatId, "Enter Naira amount to swap:", { parse_mode: "HTML" });
  }

  if (data.startsWith("sell_") && u.waitingSwap && u.swapType === "crypto_to_naira") {
    u.selectedCrypto = data.split("_")[1];
    return bot.sendMessage(chatId, `Enter ${u.selectedCrypto.toUpperCase()} amount to swap:`, { parse_mode: "HTML" });
  }
});

// -------------------------------
// VERCEL SERVERLESS HANDLER
// -------------------------------
export default function handler(req, res) {
  if (req.method === "POST") {
    bot.processUpdate(req.body);
    return res.status(200).send("OK");
  } else {
    res.status(200).send("Bot is live");
  }
}
