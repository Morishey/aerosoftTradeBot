// ===============================
// IMPORTS
// ===============================
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");
const winston = require("winston");

// ===============================
// LOGGER CONFIGURATION
// ===============================
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({ format: winston.format.simple() }),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// ===============================
// ENV VALIDATION
// ===============================
const TOKEN = process.env.TELEGRAM_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !WEBHOOK_URL) {
  logger.error("Missing required environment variables");
  throw new Error("Missing TELEGRAM_TOKEN or WEBHOOK_URL");
}

// ===============================
// RATE LIMITER (Basic in-memory)
// ===============================
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 20; // requests per window

function checkRateLimit(userId) {
  const now = Date.now();
  const userLimits = rateLimits.get(userId) || [];
  
  // Clean old requests
  const validRequests = userLimits.filter(time => now - time < RATE_LIMIT_WINDOW);
  
  if (validRequests.length >= RATE_LIMIT_MAX) {
    return false;
  }
  
  validRequests.push(now);
  rateLimits.set(userId, validRequests);
  return true;
}

// ===============================
// INIT BOT & SERVER
// ===============================
const bot = new TelegramBot(TOKEN, {
  polling: false,
  onlyFirstMatch: true
});

const app = express();

// ===============================
// MIDDLEWARE
// ===============================
app.use(express.json());
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, { ip: req.ip });
  next();
});

// ===============================
// STATE STORAGE (In production, use Redis/DB)
// ===============================
class UserStateManager {
  constructor() {
    this.users = new Map();
    this.swapStates = new Map();
    this.withdrawStates = new Map();
    this.sessionTimeouts = new Map();
  }

  initUser(userId) {
    if (!this.users.has(userId)) {
      this.users.set(userId, {
        naira: 10000,
        btc: 1,
        eth: 5,
        sol: 10,
        usdt: 100,
        createdAt: new Date().toISOString(),
        lastActive: new Date().toISOString()
      });
      logger.debug(`Initialized user ${userId}`);
    }
    
    // Update last active
    const user = this.users.get(userId);
    user.lastActive = new Date().toISOString();
    
    // Clear any existing session timeout
    if (this.sessionTimeouts.has(userId)) {
      clearTimeout(this.sessionTimeouts.get(userId));
    }
    
    // Set session timeout (clear states after 30 minutes of inactivity)
    const timeout = setTimeout(() => {
      this.clearUserStates(userId);
      logger.debug(`Cleared states for inactive user ${userId}`);
    }, 30 * 60 * 1000);
    
    this.sessionTimeouts.set(userId, timeout);
    
    return this.users.get(userId);
  }

  clearUserStates(userId) {
    this.swapStates.delete(userId);
    this.withdrawStates.delete(userId);
    this.sessionTimeouts.delete(userId);
  }

  getUser(userId) {
    return this.users.get(userId);
  }

  updateBalance(userId, currency, amount) {
    const user = this.users.get(userId);
    if (!user) return false;
    
    if (user[currency] + amount < 0) {
      throw new Error("Insufficient balance");
    }
    
    user[currency] += amount;
    return true;
  }
}

const stateManager = new UserStateManager();

// ===============================
// KEYBOARD CONFIGURATIONS
// ===============================
const keyboards = {
  main: {
    reply_markup: {
      keyboard: [
        ["💰 Naira Wallet", "💵 ETH Wallet"],
        ["₿ BTC Wallet", "🌐 USDT Wallet"],
        ["🟣 SOL Wallet", "🔄 Swap Crypto"],
        ["🎁 Refer and Earn", "📊 View Rates"],
        ["ℹ️ How to Use", "📝 Transaction History"]
      ],
      resize_keyboard: true,
      persistent_keyboard: true
    }
  },

  wallet: (currency, symbol) => ({
    reply_markup: {
      remove_keyboard: true,
      inline_keyboard: [
        [{ text: `💸 Sell ${symbol} to NGN`, callback_data: `withdraw_${currency}` }],
        [{ text: "📤 Deposit", callback_data: `deposit_${currency}` }],
        [{ text: "📈 View Stats", callback_data: `stats_${currency}` }],
        [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
      ]
    }
  }),

  cancel: {
    reply_markup: {
      inline_keyboard: [
        [{ text: "❌ Cancel", callback_data: "cancel_action" }]
      ]
    }
  },

  confirmCancel: {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Confirm", callback_data: "confirm_withdraw" }],
        [{ text: "❌ Cancel", callback_data: "cancel_action" }]
      ]
    }
  }
};

// ===============================
// VALIDATION HELPERS
// ===============================
const validators = {
  isNumeric: (value) => !isNaN(parseFloat(value)) && isFinite(value),
  
  isValidAmount: (value, min = 0.0001, max = 1000000) => {
    const num = parseFloat(value);
    return !isNaN(num) && num >= min && num <= max;
  },
  
  isValidWallet: (wallet) => ['naira', 'btc', 'eth', 'sol', 'usdt'].includes(wallet),
  
  formatCurrency: (amount, currency) => {
    const formatter = new Intl.NumberFormat('en-NG', {
      minimumFractionDigits: 2,
      maximumFractionDigits: currency === 'naira' ? 2 : 8
    });
    return formatter.format(amount);
  }
};

// ===============================
// API SERVICE
// ===============================
class ExchangeRateService {
  constructor() {
    this.rates = {};
    this.lastUpdated = null;
    this.CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  }

  async getRates() {
    const now = Date.now();
    
    // Return cached rates if still valid
    if (this.lastUpdated && now - this.lastUpdated < this.CACHE_DURATION) {
      return this.rates;
    }

    try {
      const { data } = await axios.get(
        "https://api.coingecko.com/api/v3/simple/price",
        {
          params: {
            ids: "bitcoin,ethereum,solana,tether",
            vs_currencies: "ngn,usd"
          },
          timeout: 10000 // 10 second timeout
        }
      );

      this.rates = {
        btc: { ngn: data.bitcoin.ngn, usd: data.bitcoin.usd },
        eth: { ngn: data.ethereum.ngn, usd: data.ethereum.usd },
        sol: { ngn: data.solana.ngn, usd: data.solana.usd },
        usdt: { ngn: data.tether.ngn, usd: data.tether.usd }
      };
      
      this.lastUpdated = now;
      logger.info("Exchange rates updated successfully");
      
      return this.rates;
    } catch (error) {
      logger.error("Failed to fetch exchange rates:", error);
      
      // Return cached rates if available, otherwise throw
      if (this.lastUpdated) {
        logger.warn("Using stale exchange rates due to API failure");
        return this.rates;
      }
      
      throw new Error("Unable to fetch exchange rates");
    }
  }

  async convert(amount, fromCurrency, toCurrency = 'ngn') {
    const rates = await this.getRates();
    
    if (fromCurrency === 'naira') {
      return amount; // Naira to Naira
    }
    
    const rate = rates[fromCurrency]?.[toCurrency];
    if (!rate) {
      throw new Error(`Conversion rate not available for ${fromCurrency}`);
    }
    
    return amount * rate;
  }
}

const rateService = new ExchangeRateService();

// ===============================
// MESSAGE TEMPLATES
// ===============================
const messages = {
  welcome: "👋 Welcome to Aerosoft Trade Bot\n\nI'm here to help you manage your crypto assets. Use the menu below to get started!",
  
  walletBalance: (user, currency, symbol) => {
    const balance = user[currency];
    const formattedBalance = validators.formatCurrency(balance, currency);
    return `${symbol} ${currency.toUpperCase()} Balance: ${formattedBalance}`;
  },
  
  withdrawalConfirmation: (amount, wallet, ngnAmount) => {
    const formattedAmount = validators.formatCurrency(amount, wallet);
    const formattedNgn = validators.formatCurrency(ngnAmount, 'naira');
    return `⚠️ Confirm Withdrawal\n\n` +
           `Amount: ${formattedAmount} ${wallet.toUpperCase()}\n` +
           `Receive: ₦${formattedNgn}\n\n` +
           `*This action cannot be undone.*`;
  },
  
  withdrawalSuccess: (amount, wallet, ngnAmount) => {
    const formattedAmount = validators.formatCurrency(amount, wallet);
    const formattedNgn = validators.formatCurrency(ngnAmount, 'naira');
    return `✅ Withdrawal Successful\n\n` +
           `${formattedAmount} ${wallet.toUpperCase()} → ₦${formattedNgn}\n` +
           `Funds will be processed within 24 hours.`;
  },
  
  invalidAmount: (min, max, currency) => 
    `❌ Invalid amount. Please enter a number between ${min} and ${max} ${currency}.`,
  
  insufficientBalance: (available, currency) =>
    `❌ Insufficient balance. Available: ${validators.formatCurrency(available, currency)} ${currency.toUpperCase()}`,
  
  rateLimited: "⏰ Too many requests. Please wait a moment and try again."
};

// ===============================
// CALLBACK HANDLER
// ===============================
async function handleCallbackQuery(q) {
  const userId = q.from.id;
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;
  const data = q.data;

  try {
    // Rate limiting
    if (!checkRateLimit(userId)) {
      await bot.answerCallbackQuery(q.id, { text: messages.rateLimited, show_alert: true });
      return;
    }

    const user = stateManager.initUser(userId);

    // BACK TO MENU
    if (data === "back_to_menu" || data === "cancel_action") {
      stateManager.clearUserStates(userId);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
      return bot.sendMessage(chatId, "🏠 Main Menu", keyboards.main);
    }

    // START WITHDRAW
    if (data.startsWith("withdraw_")) {
      const wallet = data.replace("withdraw_", "");
      
      if (!validators.isValidWallet(wallet)) {
        await bot.answerCallbackQuery(q.id, { text: "Invalid wallet type", show_alert: true });
        return;
      }

      stateManager.withdrawStates.set(userId, { step: "amount", wallet });

      const balance = user[wallet];
      const maxAmount = wallet === 'naira' ? balance : balance * 0.95; // Allow 95% for crypto (keep some for fees)

      await bot.sendMessage(
        chatId,
        `Enter amount of ${wallet.toUpperCase()} to withdraw:\n\n` +
        `Available: ${validators.formatCurrency(balance, wallet)}\n` +
        `Maximum: ${validators.formatCurrency(maxAmount, wallet)}`,
        keyboards.cancel
      );

      return await bot.answerCallbackQuery(q.id);
    }

    // DEPOSIT ACTION
    if (data.startsWith("deposit_")) {
      const wallet = data.replace("deposit_", "");
      await bot.answerCallbackQuery(q.id, { 
        text: `Deposit feature for ${wallet.toUpperCase()} coming soon!`, 
        show_alert: true 
      });
      return;
    }

    // CONFIRM WITHDRAW
    if (data === "confirm_withdraw") {
      const state = stateManager.withdrawStates.get(userId);
      if (!state || state.step !== "confirm") {
        await bot.answerCallbackQuery(q.id, { text: "Session expired. Please start over.", show_alert: true });
        return;
      }

      const { wallet, amount, ngnAmount } = state;
      
      try {
        stateManager.updateBalance(userId, wallet, -amount);
        stateManager.clearUserStates(userId);

        await bot.editMessageText(
          messages.withdrawalSuccess(amount, wallet, ngnAmount),
          { chat_id: chatId, message_id: messageId }
        );

        // Log successful transaction
        logger.info(`Withdrawal successful`, { userId, wallet, amount, ngnAmount });
        
      } catch (error) {
        logger.error(`Withdrawal failed for user ${userId}:`, error);
        await bot.answerCallbackQuery(q.id, { text: error.message, show_alert: true });
      }

      return await bot.answerCallbackQuery(q.id);
    }

    await bot.answerCallbackQuery(q.id);
  } catch (error) {
    logger.error(`Callback query error for user ${userId}:`, error);
    await bot.answerCallbackQuery(q.id, { text: "An error occurred. Please try again.", show_alert: true });
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
    // Rate limiting
    if (!checkRateLimit(userId)) {
      return bot.sendMessage(chatId, messages.rateLimited);
    }

    const user = stateManager.initUser(userId);
    const withdrawState = stateManager.withdrawStates.get(userId);

    // ===============================
    // WITHDRAW AMOUNT INPUT
    // ===============================
    if (withdrawState && withdrawState.step === "amount") {
      const { wallet } = withdrawState;
      
      if (!validators.isValidAmount(text)) {
        return bot.sendMessage(
          chatId,
          messages.invalidAmount(0.0001, user[wallet], wallet),
          keyboards.cancel
        );
      }

      const amount = parseFloat(text);
      const balance = user[wallet];
      
      if (amount > balance) {
        return bot.sendMessage(
          chatId,
          messages.insufficientBalance(balance, wallet),
          keyboards.cancel
        );
      }

      try {
        const ngnAmount = await rateService.convert(amount, wallet);
        
        stateManager.withdrawStates.set(userId, {
          step: "confirm",
          wallet,
          amount,
          ngnAmount,
          timestamp: new Date().toISOString()
        });

        return bot.sendMessage(
          chatId,
          messages.withdrawalConfirmation(amount, wallet, ngnAmount),
          keyboards.confirmCancel
        );
      } catch (error) {
        logger.error(`Conversion error for user ${userId}:`, error);
        return bot.sendMessage(
          chatId,
          "❌ Unable to fetch current exchange rates. Please try again later.",
          keyboards.cancel
        );
      }
    }

    // ===============================
    // MAIN MENU COMMANDS
    // ===============================
    switch (text) {
      case "/start":
        logger.info(`New user started: ${userId}`);
        return bot.sendMessage(chatId, messages.welcome, keyboards.main);

      case "💰 Naira Wallet":
        return bot.sendMessage(
          chatId,
          messages.walletBalance(user, 'naira', '💰'),
          keyboards.wallet('naira', '💰')
        );

      case "₿ BTC Wallet":
        return bot.sendMessage(
          chatId,
          messages.walletBalance(user, 'btc', '₿'),
          keyboards.wallet('btc', '₿')
        );

      case "💵 ETH Wallet":
        return bot.sendMessage(
          chatId,
          messages.walletBalance(user, 'eth', '💵'),
          keyboards.wallet('eth', '💵')
        );

      case "🟣 SOL Wallet":
        return bot.sendMessage(
          chatId,
          messages.walletBalance(user, 'sol', '🟣'),
          keyboards.wallet('sol', '🟣')
        );

      case "🌐 USDT Wallet":
        return bot.sendMessage(
          chatId,
          messages.walletBalance(user, 'usdt', '🌐'),
          keyboards.wallet('usdt', '🌐')
        );

      case "📊 View Rates":
        try {
          const rates = await rateService.getRates();
          const rateMessage = 
            `📊 Current Exchange Rates\n\n` +
            `₿ BTC: ₦${validators.formatCurrency(rates.btc.ngn, 'naira')}\n` +
            `💵 ETH: ₦${validators.formatCurrency(rates.eth.ngn, 'naira')}\n` +
            `🟣 SOL: ₦${validators.formatCurrency(rates.sol.ngn, 'naira')}\n` +
            `🌐 USDT: ₦${validators.formatCurrency(rates.usdt.ngn, 'naira')}\n\n` +
            `_Updated: ${new Date().toLocaleTimeString()}_`;
          
          return bot.sendMessage(chatId, rateMessage, { parse_mode: 'Markdown' });
        } catch (error) {
          logger.error("Failed to display rates:", error);
          return bot.sendMessage(chatId, "❌ Unable to fetch exchange rates. Please try again later.");
        }

      case "📝 Transaction History":
        return bot.sendMessage(
          chatId,
          "📝 Transaction history feature coming soon!",
          keyboards.main
        );

      case "ℹ️ How to Use":
        const helpMessage = 
          `ℹ️ *How to Use Aerosoft Trade Bot*\n\n` +
          `1. *Check Balances*: Tap any wallet button\n` +
          `2. *Withdraw*: Select "Sell to NGN" from wallet menu\n` +
          `3. *View Rates*: Get current exchange rates\n` +
          `4. *Swap Crypto*: Exchange between cryptocurrencies\n\n` +
          `*Need Help?* Contact support @example_support`;
        
        return bot.sendMessage(chatId, helpMessage, { 
          parse_mode: 'Markdown',
          ...keyboards.main 
        });

      default:
        return bot.sendMessage(
          chatId,
          "❌ Please use the menu buttons below",
          keyboards.main
        );
    }
  } catch (error) {
    logger.error(`Message handling error for user ${userId}:`, error);
    return bot.sendMessage(
      chatId,
      "❌ An error occurred. Please try again or contact support.",
      keyboards.main
    );
  }
}

// ===============================
// ERROR HANDLING MIDDLEWARE
// ===============================
app.use((error, req, res, next) => {
  logger.error("Unhandled error:", error);
  res.status(500).json({ error: "Internal server error" });
});

// ===============================
// WEBHOOK ENDPOINT
// ===============================
app.post("/webhook", async (req, res) => {
  try {
    if (req.body.message) {
      await handleMessage(req.body.message);
    } else if (req.body.callback_query) {
      await handleCallbackQuery(req.body.callback_query);
    }
    
    res.sendStatus(200);
  } catch (error) {
    logger.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

// ===============================
// HEALTH CHECK ENDPOINT
// ===============================
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    users: stateManager.users.size,
    uptime: process.uptime()
  });
});

// ===============================
// SERVER INITIALIZATION
// ===============================
async function initializeBot() {
  try {
    // Set webhook
    await bot.setWebHook(`${WEBHOOK_URL}/webhook`);
    logger.info(`Webhook set to ${WEBHOOK_URL}/webhook`);
    
    // Start server
    app.listen(PORT, () => {
      logger.info(`Bot server running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    logger.error("Failed to initialize bot:", error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received. Shutting down gracefully...');
  process.exit(0);
});

// Initialize the bot
initializeBot();