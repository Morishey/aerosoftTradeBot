// ===============================
// IMPORTS
// ===============================
require("dotenv").config();
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
// INIT BOT & SERVER
// ===============================
const bot = new TelegramBot(TOKEN);
const app = express();
app.use(express.json());

// Set webhook
bot.setWebHook(`${WEBHOOK_URL}/webhook`);

// ===============================
// USER BALANCES & STATES
// ===============================
const users = {};          // store user balances
const swapStates = {};     // track swap sessions
const withdrawStates = {}; // track withdrawals awaiting amount input

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
// BACK TO MENU INLINE BUTTON
// ===============================
function backToMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
      ]
    }
  };
}

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
// HANDLE CALLBACK (INLINE BUTTONS)
// ===============================
async function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  initUser(userId);

  // ===========================
  // Back to Main Menu
  // ===========================
  if (data === "back_to_menu") {
    delete swapStates[userId];
    delete withdrawStates[userId];
    await bot.sendMessage(userId, "🏠 Main Menu:", defaultKeyboard);
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // ===========================
  // Swap Inline
  // ===========================
  if (data.startsWith("swap_from_")) {
    swapStates[userId] = { step: 2, from: data.replace("swap_from_", "") };
    const toKeyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "BTC", callback_data: "swap_to_BTC" }, { text: "ETH", callback_data: "swap_to_ETH" }],
          [{ text: "SOL", callback_data: "swap_to_SOL" }, { text: "USDT", callback_data: "swap_to_USDT" }],
          [{ text: "NGN", callback_data: "swap_to_NGN" }]
        ]
      }
    };
    return bot.sendMessage(chatId, `Select crypto to receive:`, toKeyboard);
  }

  if (data.startsWith("swap_to_")) {
    if (!swapStates[userId]) return; // safety check
    swapStates[userId].to = data.replace("swap_to_", "");
    swapStates[userId].step = 3;
    return bot.sendMessage(chatId, `Enter amount of ${swapStates[userId].from} to swap:`);
  }

  // ===========================
  // Withdraw Inline Buttons
  // ===========================
  if (data.startsWith("withdraw_")) {
    const wallet = data.replace("withdraw_", "");
    withdrawStates[userId] = { step: 1, wallet };
    return bot.sendMessage(chatId, `Enter amount of ${wallet.toUpperCase()} to withdraw:`);
  }

  await bot.answerCallbackQuery(callbackQuery.id);
}

// ===============================
// HANDLE MESSAGES
// ===============================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  initUser(userId);
  const swapState = swapStates[userId];
  const withdrawState = withdrawStates[userId];

  // =========================
  // Handle Swap Amount
  // =========================
  if (swapState && swapState.step === 3) {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0 || amount > users[userId][swapState.from.toLowerCase()]) {
      return bot.sendMessage(chatId, `❌ Invalid amount. You have ${users[userId][swapState.from.toLowerCase()]} ${swapState.from}`);
    }

    const rates = await fetchNgnRates();
    const fromRate = rates[swapState.from.toLowerCase()];
    const toRate = swapState.to === "NGN" ? 1 : rates[swapState.to.toLowerCase()];
    const swappedAmount = swapState.to === "NGN" ? amount * fromRate : (amount * fromRate) / toRate;

    users[userId][swapState.from.toLowerCase()] -= amount;
    if (swapState.to !== "NGN") users[userId][swapState.to.toLowerCase()] += swappedAmount;
    else users[userId].naira += swappedAmount;

    delete swapStates[userId];

    return bot.sendMessage(
      chatId,
      `✅ Swap complete!\nYou swapped ${amount} ${swapState.from} → ${swappedAmount.toFixed(6)} ${swapState.to}`,
      backToMenuKeyboard()
    );
  }

  // =========================
  // Handle Withdraw Amount
  // =========================
  if (withdrawState && withdrawState.step === 1) {
    const amount = parseFloat(text);
    const wallet = withdrawState.wallet.toLowerCase();

    if (isNaN(amount) || amount <= 0 || amount > users[userId][wallet]) {
      return bot.sendMessage(chatId, `❌ Invalid amount. You have ${users[userId][wallet]} ${wallet.toUpperCase()}`);
    }

    let ngnAmount = wallet === "naira" ? amount : (await fetchNgnRates())[wallet] * amount;

    users[userId][wallet] -= amount;
    delete withdrawStates[userId];

    return bot.sendMessage(
      chatId,
      `✅ Withdrawal request submitted!\n${amount} ${wallet.toUpperCase()} → ₦${ngnAmount.toFixed(2)}`,
      backToMenuKeyboard()
    );
  }

  // =========================
  // Regular Buttons
  // =========================
  switch (text) {
    case "/start":
      return bot.sendMessage(chatId, "👋 Welcome to Aerosoft Trade Bot! Select an option below:", defaultKeyboard);

    // Wallets
    case "💰 Naira Wallet":
      return bot.sendMessage(chatId,
        `💰 Your Naira balance: ₦${users[userId].naira}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💸 Withdraw to Bank", callback_data: "withdraw_naira" }],
              [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
            ]
          }
        }
      );

    case "₿ BTC Wallet":
      return bot.sendMessage(chatId,
        `₿ Your BTC balance: ${users[userId].btc}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💸 Withdraw to NGN", callback_data: "withdraw_btc" }],
              [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
            ]
          }
        }
      );

    case "💵 ETH Wallet":
      return bot.sendMessage(chatId,
        `💵 Your ETH balance: ${users[userId].eth}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💸 Withdraw to NGN", callback_data: "withdraw_eth" }],
              [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
            ]
          }
        }
      );

    case "🟣 SOL Wallet":
      return bot.sendMessage(chatId,
        `🟣 Your SOL balance: ${users[userId].sol}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💸 Withdraw to NGN", callback_data: "withdraw_sol" }],
              [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
            ]
          }
        }
      );

    case "🌐 USDT Wallet":
      return bot.sendMessage(chatId,
        `🌐 Your USDT balance: ${users[userId].usdt}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💸 Withdraw to NGN", callback_data: "withdraw_usdt" }],
              [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
            ]
          }
        }
      );

    // Swap
    case "🔄 Swap Crypto":
      swapStates[userId] = { step: 1 };
      const fromKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "BTC", callback_data: "swap_from_BTC" }, { text: "ETH", callback_data: "swap_from_ETH" }],
            [{ text: "SOL", callback_data: "swap_from_SOL" }, { text: "USDT", callback_data: "swap_from_USDT" }]
          ]
        }
      };
      return bot.sendMessage(chatId, "Select crypto to swap from:", fromKeyboard);

    // Other
    case "🎁 Refer and Earn":
      return bot.sendMessage(chatId, `🎁 Invite your friends! Share this bot link: ${WEBHOOK_URL}`, backToMenuKeyboard());

    case "📊 View Rates":
      const rates = await fetchNgnRates();
      if (!rates) return bot.sendMessage(chatId, "❌ Unable to fetch rates", backToMenuKeyboard());
      return bot.sendMessage(
        chatId,
        `📊 LIVE RATES (NGN)\nUSDT: ₦${rates.usdt}\nBTC: ₦${rates.btc}\nETH: ₦${rates.eth}\nSOL: ₦${rates.sol}`,
        backToMenuKeyboard()
      );

    case "ℹ️ How to Use":
      return bot.sendMessage(chatId,
        `ℹ️ How to use Aerosoft Trade Bot:\n1️⃣ Click a wallet to check your balance\n2️⃣ Click 'View Rates'\n3️⃣ Swap crypto\n4️⃣ Invite friends\n5️⃣ Withdraw wallets`,
        backToMenuKeyboard()
      );

    default:
      return bot.sendMessage(chatId, `❌ Unknown command. Please use the keyboard below.`, defaultKeyboard);
  }
}

// ===============================
// WEBHOOK ENDPOINT
// ===============================
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (body.message) await handleMessage(body.message);
    if (body.callback_query) await handleCallbackQuery(body.callback_query);
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// ===============================
// HEALTH CHECK
// ===============================
app.get("/", (req, res) => res.send("✅ Aerosoft Trade Bot running"));

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot running on port", PORT));
