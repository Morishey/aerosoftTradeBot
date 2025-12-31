// ===============================
// IMPORTS
// ===============================
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// ===============================
// TELEGRAM TOKEN (from ENV)
// ===============================
const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) throw new Error("Missing TELEGRAM_TOKEN environment variable!");

// ===============================
// INITIALIZE BOT (WEBHOOK MODE)
// ===============================
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${process.env.VERCEL_URL}/api/bot`); // Vercel will handle requests at this path

// ===============================
// USER BALANCES AND ACCOUNTS
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
    console.error("CoinGecko fetch error:", err.message);
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
// INLINE BUTTONS
// ===============================
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

// ===============================
// HANDLER FOR MESSAGES
// ===============================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  initUser(userId);
  const u = users[userId];

  // BANK DETAILS
  if (u.waitingBankDetails) {
    const parts = text.split("|");
    if (parts.length !== 2) {
      return bot.sendMessage(chatId, "❌ Invalid format. Use ACCOUNT_NUMBER|BANK_NAME");
    }
    u.bankAccount = { accountNumber: parts[0].trim(), bankName: parts[1].trim() };
    u.waitingBankDetails = false;
    u.waitingWithdrawal = true;
    return bot.sendMessage(chatId, "✅ Bank account saved!\nEnter withdrawal amount:");
  }

  // NAIRA WITHDRAW
  if (u.waitingWithdrawal && u.waitingBuySell === "naira") {
    const amount = parseFloat(text.replace(/,/g, ""));
    if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "❌ Invalid amount");
    if (amount > u.naira) return bot.sendMessage(chatId, `❌ Balance too low`);
    u.naira -= amount;
    u.waitingWithdrawal = false;
    return bot.sendMessage(chatId, `✅ Withdrawal successful!\n₦${amount.toLocaleString()} sent to ${u.bankAccount.accountNumber} - ${u.bankAccount.bankName}`);
  }

  // VIEW RATES
  if (text === "📊 View Rates") {
    const rates = await fetchNgnRates();
    if (!rates) return bot.sendMessage(chatId, "❌ Unable to fetch rates");
    return bot.sendMessage(
      chatId,
      `📊 LIVE CRYPTO RATES (NGN)\nUSDT - ₦${rates.usdt}\nBTC - ₦${rates.btc}\nETH - ₦${rates.eth}\nSOL - ₦${rates.sol}`
    );
  }

  // WALLET HANDLERS
  if (text === "💰 Naira Wallet") return bot.sendMessage(chatId, `💰 NAIRA WALLET\nBalance: ₦${u.naira}`, { ...withdrawButton() });
  if (text === "🌐 USDT Wallet") return bot.sendMessage(chatId, `USDT Wallet: ${u.usdt}`, { ...tradeButtons("usdt") });
  if (text === "₿ BTC Wallet") return bot.sendMessage(chatId, `BTC Wallet: ${u.btc}`, { ...tradeButtons("btc") });
  if (text === "💵 ETH Wallet") return bot.sendMessage(chatId, `ETH Wallet: ${u.eth}`, { ...tradeButtons("eth") });
  if (text === "🟣 SOL Wallet") return bot.sendMessage(chatId, `SOL Wallet: ${u.sol}`, { ...tradeButtons("sol") });

  if (text === "🔄 Swap Crypto") return bot.sendMessage(chatId, "Select swap type", swapTypeButtons());
  if (text === "ℹ️ How to Use") return bot.sendMessage(chatId, "Use wallets, buy/sell, withdraw, swap crypto, view rates");
}

// ===============================
// CALLBACK HANDLER
// ===============================
async function handleCallback(query) {
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
    return bot.sendMessage(chatId, "❌ Operation cancelled");
  }

  // NAIRA WITHDRAW BUTTON
  if (data === "withdraw_naira") {
    if (u.naira <= 0) return bot.sendMessage(chatId, "❌ Balance too low");
    if (!u.bankAccount) {
      u.waitingBankDetails = true;
      return bot.sendMessage(chatId, "🏦 Enter bank details ACCOUNT_NUMBER|BANK_NAME");
    }
    u.waitingWithdrawal = true;
    u.waitingBuySell = "naira";
    return bot.sendMessage(chatId, "🏦 Enter amount to withdraw:");
  }

  // BUY/SELL CRYPTO
  if (data.startsWith("sell_")) {
    const asset = data.split("_")[1];
    if (u[asset] <= 0) return bot.sendMessage(chatId, `❌ Not enough ${asset}`);
    u.naira += u[asset] * rates[asset];
    u[asset] = 0;
    return bot.sendMessage(chatId, `✅ Sold ${asset}`);
  }

  if (data.startsWith("buy_")) {
    const asset = data.split("_")[1];
    if (u.naira < rates[asset]) return bot.sendMessage(chatId, `❌ Not enough Naira`);
    u.naira -= rates[asset];
    u[asset] += 1;
    return bot.sendMessage(chatId, `✅ Bought 1 ${asset}`);
  }

  // SWAP SELECTION
  if (data === "swap_naira_to_crypto") {
    u.waitingSwap = true;
    u.swapType = "naira_to_crypto";
    return bot.sendMessage(chatId, "Select crypto to buy:", cryptoSelectButtons("buy"));
  }
  if (data === "swap_crypto_to_naira") {
    u.waitingSwap = true;
    u.swapType = "crypto_to_naira";
    return bot.sendMessage(chatId, "Select crypto to sell:", cryptoSelectButtons("sell"));
  }

  // CRYPTO AMOUNT SELECTION FOR SWAP
  if ((data.startsWith("buy_") && u.waitingSwap && u.swapType === "naira_to_crypto") ||
      (data.startsWith("sell_") && u.waitingSwap && u.swapType === "crypto_to_naira")) {
    u.selectedCrypto = data.split("_")[1];
    return bot.sendMessage(chatId, "Enter amount:");
  }
}

// ===============================
// EXPORT HANDLER FOR VERCEL
// ===============================
module.exports = async (req, res) => {
  if (req.method === "POST") {
    const body = req.body;
    if (body.message) await handleMessage(body.message);
    if (body.callback_query) await handleCallback(body.callback_query);
    res.status(200).send("OK");
  } else {
    res.status(200).send("Telegram bot webhook is running");
  }
};

console.log("🤖 Aerosoft Trade Bot ready for Vercel!");
