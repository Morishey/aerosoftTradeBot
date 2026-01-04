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
// INIT BOT & SERVER
// ===============================
const bot = new TelegramBot(TOKEN);
const app = express();
app.use(express.json());

// Set webhook
bot.setWebHook(`${WEBHOOK_URL}/webhook`);

// ===============================
// USER BALANCES & SWAP STATES
// ===============================
const users = {};        // store user balances
const swapStates = {};   // track swap sessions

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
  if (!swapStates[userId]) swapStates[userId] = { step: 1 };
  const state = swapStates[userId];

  // Back to main menu
  if (data === "back_to_menu") {
    delete swapStates[userId];
    await bot.sendMessage(userId, "🏠 Main Menu:", defaultKeyboard);
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Swap inline: choose FROM
  if (data.startsWith("swap_from_")) {
    state.from = data.replace("swap_from_", "");
    state.step = 2;

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

  // Swap inline: choose TO
  if (data.startsWith("swap_to_")) {
    state.to = data.replace("swap_to_", "");
    state.step = 3;
    return bot.sendMessage(chatId, `Enter amount of ${state.from} to swap:`);
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
  const state = swapStates[userId];

  // =========================
  // IF IN SWAP FLOW: enter amount
  // =========================
  if (state && state.step === 3) {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0 || amount > users[userId][state.from.toLowerCase()]) {
      return bot.sendMessage(chatId, `❌ Invalid amount. You have ${users[userId][state.from.toLowerCase()]} ${state.from}`);
    }

    const rates = await fetchNgnRates();
    const fromRate = rates[state.from.toLowerCase()];
    const toRate = state.to === "NGN" ? 1 : rates[state.to.toLowerCase()];
    const swappedAmount = state.to === "NGN"
      ? amount * fromRate
      : (amount * fromRate) / toRate;

    // update balances
    users[userId][state.from.toLowerCase()] -= amount;
    if (state.to !== "NGN") users[userId][state.to.toLowerCase()] += swappedAmount;
    else users[userId].naira += swappedAmount;

    delete swapStates[userId];

    return bot.sendMessage(
      chatId,
      `✅ Swap complete!\nYou swapped ${amount} ${state.from} → ${swappedAmount.toFixed(6)} ${state.to}`,
      backToMenuKeyboard()
    );
  }

  // =========================
  // REGULAR BUTTONS
  // =========================
  switch (text) {
    case "/start":
      return bot.sendMessage(chatId, "👋 Welcome to Aerosoft Trade Bot! Select an option below:", defaultKeyboard);

    case "💰 Naira Wallet":
      return bot.sendMessage(chatId, `💰 Your Naira balance: ₦${users[userId].naira}`, backToMenuKeyboard());

    case "💵 ETH Wallet":
      return bot.sendMessage(chatId, `💵 Your ETH balance: ${users[userId].eth} ETH`, backToMenuKeyboard());

    case "₿ BTC Wallet":
      return bot.sendMessage(chatId, `₿ Your BTC balance: ${users[userId].btc} BTC`, backToMenuKeyboard());

    case "🌐 USDT Wallet":
      return bot.sendMessage(chatId, `🌐 Your USDT balance: ${users[userId].usdt} USDT`, backToMenuKeyboard());

    case "🟣 SOL Wallet":
      return bot.sendMessage(chatId, `🟣 Your SOL balance: ${users[userId].sol} SOL`, backToMenuKeyboard());

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

    case "🎁 Refer and Earn":
      return bot.sendMessage(chatId, `🎁 Invite your friends to earn rewards! Share this bot link: ${WEBHOOK_URL}`, backToMenuKeyboard());

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
        `ℹ️ How to use Aerosoft Trade Bot:\n1️⃣ Click a wallet to check your balance\n2️⃣ Click 'View Rates' to see live NGN prices\n3️⃣ Click 'Swap Crypto' to exchange crypto with inline buttons\n4️⃣ Invite friends to earn rewards`,
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
app.get("/", (req, res) => {
  res.send("✅ Aerosoft Trade Bot running on Replit");
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot running on port", PORT));
