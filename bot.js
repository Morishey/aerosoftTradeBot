// ===============================
// IMPORTS
// ===============================
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");

// ===============================
// ENV VALIDATION
// ===============================
const TOKEN = process.env.TELEGRAM_TOKEN;
const WEBHOOK_URL = process.env.REPLIT_URL || process.env.WEBHOOK_URL; // Replit specific

if (!TOKEN) {
  console.error("❌ Missing TELEGRAM_TOKEN in environment variables");
  console.log("💡 Go to Secrets tab in Replit and add TELEGRAM_TOKEN");
  process.exit(1);
}

// ===============================
// INIT BOT & SERVER
// ===============================
const bot = new TelegramBot(TOKEN, { polling: false });
const app = express();

// Replit uses a proxy, so we need to handle the webhook URL properly
let webhookUrl;
if (WEBHOOK_URL) {
  webhookUrl = `${WEBHOOK_URL}/webhook`;
} else {
  // For Replit, we can use the REPLIT_URL environment variable
  webhookUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co/webhook`;
}

// ===============================
// STATE STORAGE (Using Replit's Database or in-memory)
// ===============================
const users = {};
const withdrawStates = {};

// ===============================
// KEYBOARDS
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
// HELPER FUNCTIONS
// ===============================
function initUser(userId) {
  if (!users[userId]) {
    users[userId] = { 
      naira: 10000, 
      btc: 1, 
      eth: 5, 
      sol: 10, 
      usdt: 100,
      createdAt: new Date().toISOString()
    };
  }
  return users[userId];
}

async function fetchRates() {
  try {
    const { data } = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      {
        params: {
          ids: "bitcoin,ethereum,solana,tether",
          vs_currencies: "ngn"
        },
        timeout: 5000
      }
    );
    
    return {
      btc: data.bitcoin.ngn,
      eth: data.ethereum.ngn,
      sol: data.solana.ngn,
      usdt: data.tether.ngn
    };
  } catch (error) {
    console.error("Failed to fetch rates:", error.message);
    // Return fallback rates
    return {
      btc: 50000000,
      eth: 3000000,
      sol: 100000,
      usdt: 1500
    };
  }
}

function formatNumber(num, decimals = 2) {
  return new Intl.NumberFormat('en-NG', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(num);
}

// ===============================
// WEBHOOK SETUP
// ===============================
async function setupWebhook() {
  try {
    await bot.setWebHook(webhookUrl);
    console.log(`✅ Webhook set to: ${webhookUrl}`);
    
    // Get webhook info
    const webhookInfo = await bot.getWebHookInfo();
    console.log(`📊 Webhook info:`, {
      url: webhookInfo.url,
      has_custom_certificate: webhookInfo.has_custom_certificate,
      pending_update_count: webhookInfo.pending_update_count
    });
  } catch (error) {
    console.error("❌ Failed to set webhook:", error.message);
    console.log("💡 Make sure your Replit URL is accessible");
  }
}

// ===============================
// CALLBACK HANDLER
// ===============================
async function handleCallbackQuery(q) {
  const userId = q.from.id;
  const chatId = q.message.chat.id;
  const data = q.data;

  try {
    const user = initUser(userId);

    // BACK TO MENU
    if (data === "back_to_menu" || data === "cancel_action") {
      delete withdrawStates[userId];
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(chatId, "🏠 Main Menu", defaultKeyboard);
    }

    // START WITHDRAW
    if (data.startsWith("withdraw_")) {
      const wallet = data.replace("withdraw_", "");
      withdrawStates[userId] = { step: "amount", wallet };

      await bot.answerCallbackQuery(q.id);
      
      return bot.sendMessage(
        chatId,
        `💰 Enter amount of ${wallet.toUpperCase()} to withdraw:\n\n` +
        `Available: ${formatNumber(user[wallet], wallet === 'naira' ? 2 : 8)}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
    }

    // CONFIRM WITHDRAW
    if (data === "confirm_withdraw") {
      const state = withdrawStates[userId];
      if (!state) {
        await bot.answerCallbackQuery(q.id, { text: "Session expired", show_alert: true });
        return;
      }

      const { wallet, amount, ngnAmount } = state;
      
      // Deduct from user balance
      if (users[userId][wallet] >= amount) {
        users[userId][wallet] -= amount;
        users[userId].naira += ngnAmount; // Add Naira equivalent
        
        delete withdrawStates[userId];
        
        await bot.answerCallbackQuery(q.id, { text: "✅ Withdrawal successful!", show_alert: true });
        
        return bot.editMessageText(
          `✅ Withdrawal Successful!\n\n` +
          `💰 Amount: ${formatNumber(amount, wallet === 'naira' ? 2 : 8)} ${wallet.toUpperCase()}\n` +
          `💵 Received: ₦${formatNumber(ngnAmount)}\n` +
          `📊 New ${wallet.toUpperCase()} Balance: ${formatNumber(users[userId][wallet], wallet === 'naira' ? 2 : 8)}`,
          { chat_id: chatId, message_id: q.message.message_id }
        );
      } else {
        await bot.answerCallbackQuery(q.id, { text: "❌ Insufficient balance", show_alert: true });
      }
    }

    await bot.answerCallbackQuery(q.id);
  } catch (error) {
    console.error("Callback error:", error);
    await bot.answerCallbackQuery(q.id, { text: "❌ An error occurred", show_alert: true });
  }
}

// ===============================
// MESSAGE HANDLER
// ===============================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text?.trim();

  if (!text) return;

  try {
    const user = initUser(userId);
    const withdrawState = withdrawStates[userId];

    // WITHDRAW AMOUNT INPUT
    if (withdrawState && withdrawState.step === "amount") {
      const { wallet } = withdrawState;
      const amount = parseFloat(text);
      
      if (isNaN(amount) || amount <= 0) {
        return bot.sendMessage(chatId, "❌ Please enter a valid number");
      }
      
      if (amount > user[wallet]) {
        return bot.sendMessage(
          chatId,
          `❌ Insufficient balance!\nAvailable: ${formatNumber(user[wallet], wallet === 'naira' ? 2 : 8)} ${wallet.toUpperCase()}`
        );
      }

      let ngnAmount;
      if (wallet === 'naira') {
        ngnAmount = amount;
      } else {
        const rates = await fetchRates();
        ngnAmount = amount * rates[wallet];
      }

      withdrawStates[userId] = {
        step: "confirm",
        wallet,
        amount,
        ngnAmount
      };

      return bot.sendMessage(
        chatId,
        `⚠️ Confirm Withdrawal\n\n` +
        `💰 Amount: ${formatNumber(amount, wallet === 'naira' ? 2 : 8)} ${wallet.toUpperCase()}\n` +
        `💵 You'll receive: ₦${formatNumber(ngnAmount)}\n` +
        `📊 Fee: ₦0\n` +
        `📈 Total: ₦${formatNumber(ngnAmount)}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Confirm", callback_data: "confirm_withdraw" }],
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
    }

    // MAIN MENU COMMANDS
    switch (text) {
      case "/start":
        return bot.sendMessage(
          chatId,
          `👋 Welcome to Aerosoft Trade Bot!\n\n` +
          `I'm your personal crypto trading assistant. Here's what you can do:\n\n` +
          `💰 Check wallet balances\n` +
          `💸 Withdraw to bank\n` +
          `📊 View live exchange rates\n` +
          `🔄 Swap between cryptocurrencies\n\n` +
          `Use the menu below to get started!`,
          defaultKeyboard
        );

      case "💰 Naira Wallet":
        return bot.sendMessage(
          chatId,
          `💰 Naira Wallet\n\n` +
          `Balance: ₦${formatNumber(user.naira)}\n` +
          `Account Status: ✅ Active\n\n` +
          `What would you like to do?`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "💸 Withdraw to Bank", callback_data: "withdraw_naira" }],
                [{ text: "📥 Deposit Naira", callback_data: "deposit_naira" }],
                [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
              ]
            }
          }
        );

      case "₿ BTC Wallet":
        const btcRates = await fetchRates();
        return bot.sendMessage(
          chatId,
          `₿ BTC Wallet\n\n` +
          `Balance: ${formatNumber(user.btc, 8)} BTC\n` +
          `Value: ₦${formatNumber(user.btc * btcRates.btc)}\n` +
          `Rate: ₦${formatNumber(btcRates.btc)} per BTC`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "💸 Sell BTC to NGN", callback_data: "withdraw_btc" }],
                [{ text: "📥 Deposit BTC", callback_data: "deposit_btc" }],
                [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
              ]
            }
          }
        );

      case "💵 ETH Wallet":
        const ethRates = await fetchRates();
        return bot.sendMessage(
          chatId,
          `💵 ETH Wallet\n\n` +
          `Balance: ${formatNumber(user.eth, 8)} ETH\n` +
          `Value: ₦${formatNumber(user.eth * ethRates.eth)}\n` +
          `Rate: ₦${formatNumber(ethRates.eth)} per ETH`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "💸 Sell ETH to NGN", callback_data: "withdraw_eth" }],
                [{ text: "📥 Deposit ETH", callback_data: "deposit_eth" }],
                [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
              ]
            }
          }
        );

      case "🟣 SOL Wallet":
        const solRates = await fetchRates();
        return bot.sendMessage(
          chatId,
          `🟣 SOL Wallet\n\n` +
          `Balance: ${formatNumber(user.sol, 8)} SOL\n` +
          `Value: ₦${formatNumber(user.sol * solRates.sol)}\n` +
          `Rate: ₦${formatNumber(solRates.sol)} per SOL`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "💸 Sell SOL to NGN", callback_data: "withdraw_sol" }],
                [{ text: "📥 Deposit SOL", callback_data: "deposit_sol" }],
                [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
              ]
            }
          }
        );

      case "🌐 USDT Wallet":
        const usdtRates = await fetchRates();
        return bot.sendMessage(
          chatId,
          `🌐 USDT Wallet\n\n` +
          `Balance: ${formatNumber(user.usdt, 2)} USDT\n` +
          `Value: ₦${formatNumber(user.usdt * usdtRates.usdt)}\n` +
          `Rate: ₦${formatNumber(usdtRates.usdt)} per USDT`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "💸 Sell USDT to NGN", callback_data: "withdraw_usdt" }],
                [{ text: "📥 Deposit USDT", callback_data: "deposit_usdt" }],
                [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
              ]
            }
          }
        );

      case "📊 View Rates":
        try {
          const rates = await fetchRates();
          const rateMessage = 
            `📊 Live Exchange Rates\n\n` +
            `₿ 1 BTC = ₦${formatNumber(rates.btc)}\n` +
            `💵 1 ETH = ₦${formatNumber(rates.eth)}\n` +
            `🟣 1 SOL = ₦${formatNumber(rates.sol)}\n` +
            `🌐 1 USDT = ₦${formatNumber(rates.usdt)}\n\n` +
            `_Updates every 5 minutes_`;
          
          return bot.sendMessage(chatId, rateMessage, { parse_mode: 'Markdown' });
        } catch (error) {
          return bot.sendMessage(chatId, "❌ Unable to fetch rates. Please try again.");
        }

      case "ℹ️ How to Use":
        return bot.sendMessage(
          chatId,
          `ℹ️ How to Use This Bot\n\n` +
          `1. *Check Balances*: Tap any wallet button\n` +
          `2. *Withdraw*: Select "Sell to NGN" from wallet menu\n` +
          `3. *Enter Amount*: Type the amount you want to withdraw\n` +
          `4. *Confirm*: Review and confirm the transaction\n\n` +
          `📞 Support: @YourSupportChannel\n` +
          `⚠️ Always verify rates before trading`,
          { parse_mode: 'Markdown' }
        );

      default:
        return bot.sendMessage(chatId, "❌ Please use the menu buttons below", defaultKeyboard);
    }
  } catch (error) {
    console.error("Message handling error:", error);
    return bot.sendMessage(chatId, "❌ An error occurred. Please try again.", defaultKeyboard);
  }
}

// ===============================
// EXPRESS SETUP
// ===============================
app.use(express.json());

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Telegram Bot",
    users: Object.keys(users).length,
    uptime: process.uptime()
  });
});

// Webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    if (req.body.message) {
      await handleMessage(req.body.message);
    } else if (req.body.callback_query) {
      await handleCallbackQuery(req.body.callback_query);
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Replit URL: https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`);
  
  // Setup webhook after server starts
  await setupWebhook();
  
  // Log startup info
  console.log(`🤖 Bot initialized with token: ${TOKEN.substring(0, 10)}...`);
  console.log(`📊 Ready to receive updates`);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});