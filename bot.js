// ===============================
// IMPORTS
// ===============================
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");
const crypto = require("crypto");

// ===============================
// ENV VALIDATION
// ===============================
const TOKEN = process.env.TELEGRAM_TOKEN;
const WEBHOOK_URL = process.env.REPLIT_URL || process.env.WEBHOOK_URL;
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const FLW_PUBLIC_KEY = process.env.FLW_PUBLIC_KEY;
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Aerosoft Trade";

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
app.use(express.json());

// Debug bot connection
bot.getMe().then(me => {
  console.log(`🤖 Bot connected: @${me.username}`);
}).catch(err => {
  console.error('❌ Bot connection failed:', err);
});

// Replit uses a proxy, so we need to handle the webhook URL properly
let webhookUrl;
if (WEBHOOK_URL && WEBHOOK_URL !== "your_replit_url_here (optional)") {
  webhookUrl = `${WEBHOOK_URL}/webhook`;
<<<<<<< HEAD
} else if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
  webhookUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co/webhook`;
} else {
  console.error("❌ Could not determine webhook URL");
  process.exit(1);
=======
} else if (process.env.REPLIT_DEV_DOMAIN) {
  webhookUrl = `https://${process.env.REPLIT_DEV_DOMAIN}/webhook`;
} else {
  // Fallback to construction logic if env var is missing
  webhookUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.replit.app/webhook`;
>>>>>>> 5beb222181e42b4c3c2908baaa2ee11ded164286
}

console.log(`🌐 Webhook URL: ${webhookUrl}`);

// ===============================
// STATE STORAGE
// ===============================
const users = {};
const withdrawStates = {};
const swapStates = {};
const referralCodes = {};
const bankAccountStates = {};

// Nigerian banks (will be populated from Flutterwave)
let NIGERIAN_BANKS = [];

// Bank code mapping for fallback
const BANK_CODES = {
  "Access Bank": "044",
  "First Bank of Nigeria": "011",
  "Guaranty Trust Bank": "058",
  "United Bank for Africa": "033",
  "Zenith Bank": "057",
  "Fidelity Bank": "070",
  "Ecobank Nigeria": "050",
  "Union Bank of Nigeria": "032",
  "Stanbic IBTC Bank": "039",
  "Sterling Bank": "232",
  "Wema Bank": "035",
  "Polaris Bank": "076",
  "Unity Bank": "215",
  "Jaiz Bank": "301",
  "Keystone Bank": "082",
  "Providus Bank": "101",
  "SunTrust Bank": "100",
  "Heritage Bank": "030",
  "Titan Trust Bank": "102",
  "Globus Bank": "103"
};

// ===============================
// PAYMENT PROCESSOR (Flutterwave)
// ===============================
class PaymentProcessor {
  constructor() {
    this.baseURL = 'https://api.flutterwave.com/v3';
    this.headers = {
      Authorization: `Bearer ${FLW_SECRET_KEY}`,
      'Content-Type': 'application/json'
    };
  }

  async verifyBankAccount(accountNumber, bankCode) {
    try {
      const response = await axios.post(
        `${this.baseURL}/accounts/resolve`,
        {
          account_number: accountNumber,
          account_bank: bankCode
        },
        { headers: this.headers, timeout: 10000 }
      );
      
      return {
        success: true,
        accountName: response.data.data.account_name,
        accountNumber: response.data.data.account_number
      };
    } catch (error) {
      console.error('Account verification failed:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || 'Account verification failed'
      };
    }
  }

  async processTransfer(transferData) {
    try {
      const { amount, recipient, reference } = transferData;
      
      const payload = {
        account_bank: recipient.bankCode,
        account_number: recipient.accountNumber,
        amount: Math.round(amount),
        narration: `Withdrawal from ${BUSINESS_NAME}`,
        currency: "NGN",
        reference: reference,
        beneficiary_name: recipient.accountName,
        callback_url: `${webhookUrl.replace('/webhook', '')}/transfer-webhook`
      };

      const response = await axios.post(
        `${this.baseURL}/transfers`,
        payload,
        { headers: this.headers, timeout: 15000 }
      );

      return {
        success: true,
        data: response.data,
        transferId: response.data.data.id,
        reference: response.data.data.reference
      };
    } catch (error) {
      console.error('Transfer failed:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || 'Transfer failed. Please try again later.'
      };
    }
  }

  async checkTransferStatus(transferId) {
    try {
      const response = await axios.get(
        `${this.baseURL}/transfers/${transferId}`,
        { headers: this.headers, timeout: 10000 }
      );
      return response.data;
    } catch (error) {
      console.error('Status check failed:', error.message);
      return null;
    }
  }

  async getBanks() {
    try {
      const response = await axios.get(
        `${this.baseURL}/banks/NG`,
        { headers: this.headers, timeout: 10000 }
      );
      
      return response.data.data.map(bank => ({
        name: bank.name,
        code: bank.code,
        id: bank.id
      }));
    } catch (error) {
      console.error('Failed to fetch banks, using fallback:', error.message);
      return Object.entries(BANK_CODES).map(([name, code]) => ({
        name,
        code,
        id: code
      }));
    }
  }

  verifyWebhookSignature(payload, signature) {
    if (!process.env.FLW_WEBHOOK_SECRET) return true;
    
    const hash = crypto.createHmac('sha256', process.env.FLW_WEBHOOK_SECRET)
      .update(JSON.stringify(payload))
      .digest('hex');
    
    return hash === signature;
  }
}

// Initialize payment processor
const paymentProcessor = new PaymentProcessor();

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
      ["🏦 Bank Account", "ℹ️ How to Use"]
    ],
    resize_keyboard: true,
    persistent_keyboard: true
  }
};

const swapKeyboard = {
  reply_markup: {
    keyboard: [
      ["BTC → USDT", "ETH → USDT"],
      ["SOL → USDT", "USDT → BTC"],
      ["USDT → ETH", "USDT → SOL"],
      ["⬅️ Back to Main Menu"]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  }
};

// ===============================
// HELPER FUNCTIONS
// ===============================
function initUser(userId, referredBy = null) {
  if (!users[userId]) {
    users[userId] = { 
      naira: 10000, 
      btc: 1, 
      eth: 5, 
      sol: 10, 
      usdt: 100,
      createdAt: new Date().toISOString(),
      referralCode: generateReferralCode(userId),
      referredBy: referredBy,
      referrals: [],
      referralRewards: 0,
      bankAccount: null,
      transactions: [],
      totalWithdrawn: 0,
      totalDeposited: 0,
      kycVerified: false,
      dailyWithdrawalLimit: 500000,
      dailyWithdrawn: 0,
      lastWithdrawalDate: null
    };
    
    if (referredBy && users[referredBy]) {
      users[referredBy].referrals.push({
        userId: userId,
        date: new Date().toISOString(),
        bonus: 100
      });
      users[referredBy].referralRewards += 100;
      users[referredBy].naira += 100;
      
      createTransaction(referredBy, 'referral_bonus', 100, {
        currency: 'NGN',
        referredUserId: userId,
        type: 'referral'
      });
    }
  }
  return users[userId];
}

function generateReferralCode(userId) {
  const code = 'AERO' + Math.random().toString(36).substring(2, 8).toUpperCase();
  referralCodes[code] = userId;
  return code;
}

async function fetchRates() {
  try {
    const { data } = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      {
        params: {
          ids: "bitcoin,ethereum,solana,tether",
          vs_currencies: "ngn,usd"
        },
        timeout: 5000
      }
    );
    
    return {
      btc: { ngn: data.bitcoin.ngn, usd: data.bitcoin.usd },
      eth: { ngn: data.ethereum.ngn, usd: data.ethereum.usd },
      sol: { ngn: data.solana.ngn, usd: data.solana.usd },
      usdt: { ngn: data.tether.ngn, usd: data.tether.usd },
      usd_ngn: { buy: 1440.00, sell: 1500.00 }
    };
  } catch (error) {
    console.error("Failed to fetch rates:", error.message);
    return {
      btc: { ngn: 50000000, usd: 35000 },
      eth: { ngn: 3000000, usd: 2000 },
      sol: { ngn: 100000, usd: 70 },
      usdt: { ngn: 1500, usd: 1 },
      usd_ngn: { buy: 1440.00, sell: 1500.00 }
    };
  }
}

function formatNumber(num, decimals = 2) {
  return new Intl.NumberFormat('en-NG', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(num);
}

function validateAccountNumber(accountNumber) {
  return /^\d{10}$/.test(accountNumber);
}

function validateAccountName(accountName) {
  const words = accountName.trim().split(/\s+/);
  return words.length >= 2 && accountName.length >= 5;
}

function createTransaction(userId, type, amount, details) {
  const transaction = {
    id: Date.now() + Math.random().toString(36).substr(2, 9),
    type: type,
    amount: amount,
    currency: details.currency || 'NGN',
    status: 'pending',
    details: details,
    timestamp: new Date().toISOString(),
    completedAt: null,
    userId: userId
  };
  
  if (!users[userId].transactions) {
    users[userId].transactions = [];
  }
  
  users[userId].transactions.push(transaction);
  return transaction;
}

function calculateSwap(amount, fromRate, toRate) {
  const fee = 0.005;
  const amountAfterFee = amount * (1 - fee);
  const received = (amountAfterFee * fromRate) / toRate;
  return {
    received: received,
    fee: amount * fee,
    feePercent: fee * 100
  };
}

function checkWithdrawalLimit(userId, amount) {
  const user = users[userId];
  const today = new Date().toDateString();
  
  if (user.lastWithdrawalDate !== today) {
    user.dailyWithdrawn = 0;
    user.lastWithdrawalDate = today;
  }
  
  if (amount > 100000 && !user.kycVerified) {
    return {
      allowed: false,
      reason: "KYC verification required for withdrawals above ₦100,000",
      limit: 100000
    };
  }
  
  if (user.dailyWithdrawn + amount > user.dailyWithdrawalLimit) {
    return {
      allowed: false,
      reason: `Daily withdrawal limit exceeded. Limit: ₦${formatNumber(user.dailyWithdrawalLimit)}`,
      remaining: user.dailyWithdrawalLimit - user.dailyWithdrawn
    };
  }
  
  return { allowed: true, remaining: user.dailyWithdrawalLimit - user.dailyWithdrawn };
}

async function processRealWithdrawal(userId, amount, bankDetails) {
  const user = users[userId];
  
  const limitCheck = checkWithdrawalLimit(userId, amount);
  if (!limitCheck.allowed) {
    return {
      success: false,
      error: limitCheck.reason,
      limitInfo: limitCheck
    };
  }
  
  const reference = `AERO${Date.now()}${Math.random().toString(36).substr(2, 5)}`.toUpperCase();
  
  const verification = await paymentProcessor.verifyBankAccount(
    bankDetails.accountNumber,
    bankDetails.bankCode
  );
  
  if (!verification.success) {
    return {
      success: false,
      error: "Account verification failed: " + verification.error
    };
  }
  
  const providedName = bankDetails.accountName.toLowerCase().replace(/\s+/g, ' ');
  const verifiedName = verification.accountName.toLowerCase().replace(/\s+/g, ' ');
  
  if (providedName !== verifiedName) {
    return {
      success: false,
      error: `Account name doesn't match. Expected: ${verification.accountName}`
    };
  }
  
  const transaction = createTransaction(userId, 'withdrawal', amount, {
    currency: 'NGN',
    bank: bankDetails.bankName,
    bankCode: bankDetails.bankCode,
    accountNumber: bankDetails.accountNumber,
    accountName: bankDetails.accountName,
    reference: reference,
    status: 'processing',
    provider: 'flutterwave',
    amount: amount
  });
  
  const transferResult = await paymentProcessor.processTransfer({
    amount: amount,
    recipient: {
      bankCode: bankDetails.bankCode,
      accountNumber: bankDetails.accountNumber,
      accountName: bankDetails.accountName
    },
    reference: reference
  });
  
  if (!transferResult.success) {
    transaction.status = 'failed';
    transaction.error = transferResult.error;
    return {
      success: false,
      error: transferResult.error
    };
  }
  
  user.naira -= amount;
  user.totalWithdrawn += amount;
  user.dailyWithdrawn += amount;
  user.lastWithdrawalDate = new Date().toDateString();
  
  transaction.status = 'processing';
  transaction.transferId = transferResult.transferId;
  transaction.providerReference = transferResult.reference;
  transaction.providerResponse = transferResult.data;
  
  return {
    success: true,
    transactionId: transaction.id,
    reference: reference,
    transferId: transferResult.transferId,
    amount: amount
  };
}

// ===============================
// WEBHOOK SETUP
// ===============================
async function setupWebhook() {
  try {
    console.log('🔄 Setting up webhook...');
    
    // First delete any existing webhook
    try {
      await bot.deleteWebHook();
      console.log('🗑️ Existing webhook deleted');
    } catch (error) {
      console.log('ℹ️ No existing webhook to delete');
    }
    
    // Set new webhook
    await bot.setWebHook(webhookUrl);
    console.log(`✅ Webhook set to: ${webhookUrl}`);
    
    // Verify webhook
    const info = await bot.getWebHookInfo();
    console.log('📊 Webhook info:', {
      url: info.url,
      pendingUpdates: info.pending_update_count,
      lastError: info.last_error_message
    });
    
    return true;
  } catch (error) {
    console.error("❌ Failed to set webhook:", error.message);
    console.error("❌ Error details:", error);
    return false;
  }
}

// ===============================
// CALLBACK HANDLER
// ===============================
async function handleCallbackQuery(q) {
  const userId = q.from.id;
  const chatId = q.message.chat.id;
  const data = q.data;

  console.log(`🔘 Callback query from ${userId}: ${data}`);

  try {
    // Answer callback query immediately
    await bot.answerCallbackQuery(q.id);

    const user = initUser(userId);

    // BACK TO MENU
    if (data === "back_to_menu" || data === "cancel_action") {
      delete withdrawStates[userId];
      delete swapStates[userId];
      delete bankAccountStates[userId];
      return bot.sendMessage(chatId, "🏠 Main Menu", defaultKeyboard);
    }

    // REFRESH RATES
    if (data === "refresh_rates") {
      const rates = await fetchRates();
      const rateMessage = 
        `📊 *Live Exchange Rates*\n\n` +
        `*🌐 USD/NGN RATES*\n` +
        `💵 BUY: ₦${formatNumber(rates.usd_ngn.buy)} per $1\n` +
        `💰 SELL: ₦${formatNumber(rates.usd_ngn.sell)} per $1\n\n` +
        `*💎 CRYPTOCURRENCIES*\n` +
        `₿ BTC: ₦${formatNumber(rates.btc.ngn)} ($${formatNumber(rates.btc.usd)})\n` +
        `💵 ETH: ₦${formatNumber(rates.eth.ngn)} ($${formatNumber(rates.eth.usd)})\n` +
        `🟣 SOL: ₦${formatNumber(rates.sol.ngn)} ($${formatNumber(rates.sol.usd)})\n` +
        `🌐 USDT: ₦${formatNumber(rates.usdt.ngn)} ($${formatNumber(rates.usdt.usd)})\n\n` +
        `📈 *Spread Information:*\n` +
        `• USD/NGN spread: ₦${formatNumber(rates.usd_ngn.sell - rates.usd_ngn.buy)}\n` +
        `• Crypto rates update every 5 minutes\n` +
        `• USD/NGN rates are fixed\n\n` +
        `_Last updated: ${new Date().toLocaleTimeString()}_`;
      
      try {
        await bot.editMessageText(rateMessage, {
          chat_id: chatId,
          message_id: q.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Refresh Rates", callback_data: "refresh_rates" }],
              [{ text: "⬅️ Back to Menu", callback_data: "back_to_menu" }]
            ]
          }
        });
      } catch (error) {
        // If edit fails, send new message
        await bot.sendMessage(chatId, rateMessage, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Refresh Rates", callback_data: "refresh_rates" }],
              [{ text: "⬅️ Back to Menu", callback_data: "back_to_menu" }]
            ]
          }
        });
      }
      return;
    }

    // DEPOSIT HANDLERS
    if (data.startsWith("deposit_")) {
      const wallet = data.replace("deposit_", "");
      let depositMsg = `📥 Deposit ${wallet.toUpperCase()}\n\n`;
      let address = "";
      
      switch(wallet) {
        case "naira":
          depositMsg += `To deposit Naira, please send to:\n`;
          depositMsg += `🏦 Bank: ${BUSINESS_NAME} Bank\n`;
          depositMsg += `📞 Account: 0123456789\n`;
          depositMsg += `👤 Name: ${BUSINESS_NAME} Trade\n\n`;
          depositMsg += `After payment, send proof to @AerosoftSupport`;
          break;
        case "btc":
          address = "1AerosoftBTCAddressExample123456789";
          depositMsg += `Send BTC to this address:\n\`${address}\`\n\n`;
          depositMsg += `Network: Bitcoin (BTC)\n`;
          depositMsg += `Minimum: 0.0001 BTC\n\n`;
          depositMsg += `💰 Your BTC balance will update after 3 confirmations.`;
          break;
        case "eth":
          address = "0xAerosoftETHAddressExample123456789";
          depositMsg += `Send ETH to this address:\n\`${address}\`\n\n`;
          depositMsg += `Network: Ethereum (ERC20)\n`;
          depositMsg += `Minimum: 0.01 ETH\n\n`;
          depositMsg += `💰 Your ETH balance will update after 12 confirmations.`;
          break;
        case "sol":
          address = "AerosoftSOLAddressExample123456789abcdefghijklmnopqrstuvwxyz";
          depositMsg += `Send SOL to this address:\n\`${address}\`\n\n`;
          depositMsg += `Network: Solana\n`;
          depositMsg += `Minimum: 0.1 SOL\n\n`;
          depositMsg += `💰 Your SOL balance will update quickly.`;
          break;
        case "usdt":
          address = "0xAerosoftUSDTAddressExample123456789";
          depositMsg += `Send USDT to this address:\n\`${address}\`\n\n`;
          depositMsg += `Network: TRC20 or ERC20\n`;
          depositMsg += `Minimum: 10 USDT\n\n`;
          depositMsg += `💰 Please specify network when sending.`;
          break;
      }
      
      return bot.sendMessage(chatId, depositMsg, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: "📋 Copy Address", callback_data: `copy_address_${wallet}` }],
            [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
          ]
        }
      });
    }

    // COPY ADDRESS HANDLER
    if (data.startsWith("copy_address_")) {
      await bot.answerCallbackQuery(q.id, { 
        text: "📋 Address copied to clipboard! (Please copy manually from message above)", 
        show_alert: true 
      });
      return;
    }

    // SHARE REFERRAL
    if (data === "share_referral") {
      const botUsername = (await bot.getMe()).username;
      const referralLink = `https://t.me/${botUsername}?start=${user.referralCode}`;
      
      return bot.sendMessage(
        chatId,
        `🎁 Share Your Referral Link\n\n` +
        `🔗 ${referralLink}\n\n` +
        `💰 You earn ₦100 for each friend who joins using your link!\n` +
        `🎯 Your friends get ₦500 bonus on their first deposit.\n\n` +
        `📤 Share this link with your friends!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📤 Share Now", url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(`Join ${BUSINESS_NAME} Bot and get ₦500 bonus!`)}` }],
              [{ text: "⬅️ Back", callback_data: "back_to_referral" }]
            ]
          }
        }
      );
    }

    // MY REFERRALS
    if (data === "my_referrals") {
      let referralsText = "👥 My Referrals\n\n";
      
      if (user.referrals.length === 0) {
        referralsText += "No referrals yet. Share your link to earn rewards!";
      } else {
        referralsText += `Total Referrals: ${user.referrals.length}\n`;
        referralsText += `Total Earnings: ₦${formatNumber(user.referralRewards)}\n\n`;
        
        user.referrals.slice(0, 10).forEach((ref, index) => {
          referralsText += `${index + 1}. User ${ref.userId.toString().slice(-6)} - ₦${ref.bonus}\n`;
        });
        
        if (user.referrals.length > 10) {
          referralsText += `\n... and ${user.referrals.length - 10} more`;
        }
      }
      
      return bot.sendMessage(chatId, referralsText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬅️ Back", callback_data: "back_to_referral" }]
          ]
        }
      });
    }

    // BACK TO REFERRAL MENU
    if (data === "back_to_referral") {
      return bot.sendMessage(
        chatId,
        `🎁 Refer and Earn\n\n` +
        `💰 Your Referral Code: ${user.referralCode}\n` +
        `👥 Total Referrals: ${user.referrals.length}\n` +
        `🎯 Total Earnings: ₦${formatNumber(user.referralRewards)}\n\n` +
        `✨ Referral Rewards:\n` +
        `• You earn ₦100 per referral\n` +
        `• Your friend gets ₦500 bonus\n` +
        `• No limit on earnings!\n\n` +
        `What would you like to do?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📤 Share Referral Link", callback_data: "share_referral" }],
              [{ text: "👥 My Referrals", callback_data: "my_referrals" }],
              [{ text: "💰 Claim Rewards", callback_data: "claim_rewards" }],
              [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
            ]
          }
        }
      );
    }

    // CLAIM REWARDS
    if (data === "claim_rewards") {
      await bot.answerCallbackQuery(q.id, { 
        text: "✅ All rewards are automatically added to your Naira wallet!", 
        show_alert: true 
      });
      return;
    }

    // SWAP ACTIONS
    if (data.startsWith("swap_")) {
      const swapType = data.replace("swap_", "");
      swapStates[userId] = { step: "amount", swapType };
      
      const [from, to] = swapType.split("_to_");
      return bot.sendMessage(
        chatId,
        `🔄 Swap ${from.toUpperCase()} to ${to.toUpperCase()}\n\n` +
        `Enter amount of ${from.toUpperCase()} to swap:\n\n` +
        `Available: ${formatNumber(user[from], from === 'usdt' ? 2 : 8)} ${from.toUpperCase()}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
    }

    // CONFIRM SWAP
    if (data === "confirm_swap") {
      const state = swapStates[userId];
      if (!state || state.step !== "confirm") {
        await bot.answerCallbackQuery(q.id, { text: "Session expired", show_alert: true });
        return;
      }

      const { swapType, amount, received, fee } = state;
      const [from, to] = swapType.split("_to_");
      
      if (users[userId][from] >= amount) {
        users[userId][from] -= amount;
        users[userId][to] += received;
        
        createTransaction(userId, 'swap', amount, {
          currency: from.toUpperCase(),
          from: from,
          to: to,
          amount: amount,
          received: received,
          fee: fee,
          rate: received / amount
        });
        
        delete swapStates[userId];
        
        await bot.answerCallbackQuery(q.id, { text: "✅ Swap successful!", show_alert: true });
        
        try {
          await bot.editMessageText(
            `✅ Swap Completed!\n\n` +
            `📤 Sent: ${formatNumber(amount, from === 'usdt' ? 2 : 8)} ${from.toUpperCase()}\n` +
            `📥 Received: ${formatNumber(received, to === 'usdt' ? 2 : 8)} ${to.toUpperCase()}\n` +
            `💰 Fee: ${formatNumber(fee, from === 'usdt' ? 2 : 8)} ${from.toUpperCase()} (0.5%)\n\n` +
            `📊 New ${from.toUpperCase()} Balance: ${formatNumber(users[userId][from], from === 'usdt' ? 2 : 8)}\n` +
            `📊 New ${to.toUpperCase()} Balance: ${formatNumber(users[userId][to], to === 'usdt' ? 2 : 8)}`,
            { chat_id: chatId, message_id: q.message.message_id }
          );
        } catch (error) {
          await bot.sendMessage(
            chatId,
            `✅ Swap Completed!\n\n` +
            `📤 Sent: ${formatNumber(amount, from === 'usdt' ? 2 : 8)} ${from.toUpperCase()}\n` +
            `📥 Received: ${formatNumber(received, to === 'usdt' ? 2 : 8)} ${to.toUpperCase()}\n` +
            `💰 Fee: ${formatNumber(fee, from === 'usdt' ? 2 : 8)} ${from.toUpperCase()} (0.5%)\n\n` +
            `📊 New ${from.toUpperCase()} Balance: ${formatNumber(users[userId][from], from === 'usdt' ? 2 : 8)}\n` +
            `📊 New ${to.toUpperCase()} Balance: ${formatNumber(users[userId][to], to === 'usdt' ? 2 : 8)}`
          );
        }
      } else {
        await bot.answerCallbackQuery(q.id, { text: "❌ Insufficient balance", show_alert: true });
      }
      return;
    }

    // WITHDRAW ACTIONS FOR CRYPTO
    if (data.startsWith("withdraw_")) {
      const wallet = data.replace("withdraw_", "");
      withdrawStates[userId] = { step: "amount", wallet };

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

    // CONFIRM CRYPTO WITHDRAW
    if (data === "confirm_withdraw") {
      const state = withdrawStates[userId];
      if (!state || state.step !== "confirm") {
        await bot.answerCallbackQuery(q.id, { text: "Session expired", show_alert: true });
        return;
      }

      const { wallet, amount, ngnAmount } = state;
      
      if (users[userId][wallet] >= amount) {
        users[userId][wallet] -= amount;
        users[userId].naira += ngnAmount;
        
        createTransaction(userId, 'crypto_sale', amount, {
          currency: wallet.toUpperCase(),
          amount: amount,
          ngnValue: ngnAmount,
          rate: ngnAmount / amount
        });
        
        delete withdrawStates[userId];
        
        await bot.answerCallbackQuery(q.id, { text: "✅ Withdrawal successful!", show_alert: true });
        
        try {
          await bot.editMessageText(
            `✅ Crypto Sale Successful!\n\n` +
            `💰 Amount: ${formatNumber(amount, wallet === 'naira' ? 2 : 8)} ${wallet.toUpperCase()}\n` +
            `💵 Received: ₦${formatNumber(ngnAmount)}\n` +
            `📊 New ${wallet.toUpperCase()} Balance: ${formatNumber(users[userId][wallet], wallet === 'naira' ? 2 : 8)}\n` +
            `📊 New Naira Balance: ₦${formatNumber(users[userId].naira)}`,
            { chat_id: chatId, message_id: q.message.message_id }
          );
        } catch (error) {
          await bot.sendMessage(
            chatId,
            `✅ Crypto Sale Successful!\n\n` +
            `💰 Amount: ${formatNumber(amount, wallet === 'naira' ? 2 : 8)} ${wallet.toUpperCase()}\n` +
            `💵 Received: ₦${formatNumber(ngnAmount)}\n` +
            `📊 New ${wallet.toUpperCase()} Balance: ${formatNumber(users[userId][wallet], wallet === 'naira' ? 2 : 8)}\n` +
            `📊 New Naira Balance: ₦${formatNumber(users[userId].naira)}`
          );
        }
      } else {
        await bot.answerCallbackQuery(q.id, { text: "❌ Insufficient balance", show_alert: true });
      }
      return;
    }

    // BANK ACCOUNT MANAGEMENT
    if (data === "add_bank_account") {
      bankAccountStates[userId] = { step: "select_bank" };
      
      if (NIGERIAN_BANKS.length === 0) {
        NIGERIAN_BANKS = await paymentProcessor.getBanks();
      }
      
      const bankButtons = NIGERIAN_BANKS.slice(0, 20).map(bank => [{
        text: bank.name,
        callback_data: `bank_selected_${bank.code}`
      }]);
      
      if (NIGERIAN_BANKS.length > 20) {
        bankButtons.push([{ text: "📄 Show More Banks", callback_data: "show_more_banks" }]);
      }
      
      bankButtons.push([{ text: "❌ Cancel", callback_data: "cancel_action" }]);
      
      return bot.sendMessage(
        chatId,
        "🏦 Select your bank from the list below:",
        {
          reply_markup: {
            inline_keyboard: bankButtons
          }
        }
      );
    }

    // SHOW MORE BANKS
    if (data === "show_more_banks") {
      const bankButtons = NIGERIAN_BANKS.slice(20).map(bank => [{
        text: bank.name,
        callback_data: `bank_selected_${bank.code}`
      }]);
      
      bankButtons.push([{ text: "⬅️ Back", callback_data: "add_bank_account" }]);
      
      try {
        await bot.editMessageText(
          "🏦 Select your bank (continued):",
          {
            chat_id: chatId,
            message_id: q.message.message_id,
            reply_markup: {
              inline_keyboard: bankButtons
            }
          }
        );
      } catch (error) {
        await bot.sendMessage(
          chatId,
          "🏦 Select your bank (continued):",
          {
            reply_markup: {
              inline_keyboard: bankButtons
            }
          }
        );
      }
      return;
    }

    if (data.startsWith("bank_selected_")) {
      const bankCode = data.replace("bank_selected_", "");
      const bank = NIGERIAN_BANKS.find(b => b.code === bankCode);
      
      if (!bank) {
        await bot.answerCallbackQuery(q.id, { text: "Bank not found. Please try again.", show_alert: true });
        return;
      }
      
      bankAccountStates[userId] = {
        step: "enter_account_number",
        bankCode: bankCode,
        bankName: bank.name
      };
      
      return bot.sendMessage(
        chatId,
        `🏦 Bank: ${bank.name}\n\nPlease enter your 10-digit account number:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
    }

    if (data === "view_bank_details") {
      if (!user.bankAccount) {
        return bot.sendMessage(
          chatId,
          "❌ No bank account added yet.\n\nClick '➕ Add Bank Account' to add your bank details.",
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "➕ Add Bank Account", callback_data: "add_bank_account" }],
                [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
              ]
            }
          }
        );
      }
      
      const bankDetails = user.bankAccount;
      const limitCheck = checkWithdrawalLimit(userId, 0);
      
      return bot.sendMessage(
        chatId,
        `🏦 Your Bank Details:\n\n` +
        `Bank: ${bankDetails.bankName}\n` +
        `Account Number: ${bankDetails.accountNumber}\n` +
        `Account Name: ${bankDetails.accountName}\n` +
        `Added: ${new Date(bankDetails.addedAt).toLocaleDateString()}\n\n` +
        `📊 Withdrawal Limits:\n` +
        `• Daily Limit: ₦${formatNumber(user.dailyWithdrawalLimit)}\n` +
        `• Used Today: ₦${formatNumber(user.dailyWithdrawn)}\n` +
        `• Remaining: ₦${formatNumber(limitCheck.remaining)}\n` +
        `• KYC Verified: ${user.kycVerified ? '✅ Yes' : '❌ No'}\n\n` +
        `To update your details, use the '✏️ Update Bank Account' option.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✏️ Update", callback_data: "update_bank_account" }],
              [{ text: "💰 Withdraw Now", callback_data: "withdraw_naira" }],
              [{ text: "❌ Remove", callback_data: "remove_bank_account" }],
              [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
            ]
          }
        }
      );
    }

    if (data === "update_bank_account") {
      if (!user.bankAccount) {
        await bot.answerCallbackQuery(q.id, { 
          text: "No bank account to update. Please add one first.", 
          show_alert: true 
        });
        return;
      }
      
      bankAccountStates[userId] = { step: "select_bank_update" };
      
      const bankButtons = NIGERIAN_BANKS.slice(0, 20).map(bank => [{
        text: bank.name,
        callback_data: `update_bank_selected_${bank.code}`
      }]);
      
      if (NIGERIAN_BANKS.length > 20) {
        bankButtons.push([{ text: "📄 Show More Banks", callback_data: "show_more_banks_update" }]);
      }
      
      bankButtons.push([{ text: "❌ Cancel", callback_data: "cancel_action" }]);
      
      return bot.sendMessage(
        chatId,
        "✏️ Select your new bank:",
        {
          reply_markup: {
            inline_keyboard: bankButtons
          }
        }
      );
    }

    if (data === "show_more_banks_update") {
      const bankButtons = NIGERIAN_BANKS.slice(20).map(bank => [{
        text: bank.name,
        callback_data: `update_bank_selected_${bank.code}`
      }]);
      
      bankButtons.push([{ text: "⬅️ Back", callback_data: "update_bank_account" }]);
      
      try {
        await bot.editMessageText(
          "✏️ Select your new bank (continued):",
          {
            chat_id: chatId,
            message_id: q.message.message_id,
            reply_markup: {
              inline_keyboard: bankButtons
            }
          }
        );
      } catch (error) {
        await bot.sendMessage(
          chatId,
          "✏️ Select your new bank (continued):",
          {
            reply_markup: {
              inline_keyboard: bankButtons
            }
          }
        );
      }
      return;
    }

    if (data.startsWith("update_bank_selected_")) {
      const bankCode = data.replace("update_bank_selected_", "");
      const bank = NIGERIAN_BANKS.find(b => b.code === bankCode);
      
      if (!bank) {
        await bot.answerCallbackQuery(q.id, { text: "Bank not found. Please try again.", show_alert: true });
        return;
      }
      
      bankAccountStates[userId] = {
        step: "enter_account_number_update",
        bankCode: bankCode,
        bankName: bank.name
      };
      
      return bot.sendMessage(
        chatId,
        `✏️ Updating Bank Account\n\n` +
        `New Bank: ${bank.name}\n\n` +
        `Please enter your 10-digit account number:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
    }

    if (data === "remove_bank_account") {
      if (!user.bankAccount) {
        await bot.answerCallbackQuery(q.id, { 
          text: "No bank account to remove", 
          show_alert: true 
        });
        return;
      }
      
      return bot.sendMessage(
        chatId,
        `⚠️ Confirm Bank Account Removal\n\n` +
        `Bank: ${user.bankAccount.bankName}\n` +
        `Account: ${user.bankAccount.accountNumber}\n\n` +
        `Are you sure you want to remove this bank account?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Yes, Remove", callback_data: "confirm_remove_bank" }],
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
    }

    if (data === "confirm_remove_bank") {
      user.bankAccount = null;
      
      await bot.answerCallbackQuery(q.id, { 
        text: "✅ Bank account removed successfully", 
        show_alert: true 
      });
      
      try {
        await bot.editMessageText(
          "✅ Bank account removed successfully",
          { chat_id: chatId, message_id: q.message.message_id }
        );
      } catch (error) {
        await bot.sendMessage(chatId, "✅ Bank account removed successfully");
      }
      return;
    }

    // WITHDRAW TO BANK
    if (data === "withdraw_naira") {
      if (!user.bankAccount) {
        await bot.answerCallbackQuery(q.id, { 
          text: "❌ Please add a bank account first", 
          show_alert: true 
        });
        return;
      }
      
      withdrawStates[userId] = { step: "amount", wallet: "naira", type: "bank" };
      
      const limitCheck = checkWithdrawalLimit(userId, 0);
      
      return bot.sendMessage(
        chatId,
        `💰 Withdraw to Bank\n\n` +
        `🏦 Bank: ${user.bankAccount.bankName}\n` +
        `👤 Account: ${user.bankAccount.accountName}\n\n` +
        `📊 Limits:\n` +
        `• Available Balance: ₦${formatNumber(user.naira)}\n` +
        `• Daily Remaining: ₦${formatNumber(limitCheck.remaining)}\n` +
        `• Minimum: ₦500\n` +
        `• Fee: 1.5% (min ₦50)\n\n` +
        `Enter amount to withdraw:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Max Available", callback_data: "withdraw_max" }],
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
    }

    // WITHDRAW MAX AMOUNT
    if (data === "withdraw_max") {
      if (!user.bankAccount) {
        await bot.answerCallbackQuery(q.id, { 
          text: "❌ Please add a bank account first", 
          show_alert: true 
        });
        return;
      }
      
      const user = users[userId];
      const limitCheck = checkWithdrawalLimit(userId, 0);
      const maxAmount = Math.min(user.naira, limitCheck.remaining);
      
      const feePercentage = 0.015;
      const calculatedFee = maxAmount * feePercentage;
      const fee = Math.max(calculatedFee, 50);
      const netAmount = maxAmount - fee;
      
      if (netAmount < 500) {
        await bot.answerCallbackQuery(q.id, { 
          text: "❌ Insufficient funds after fees. Minimum withdrawal is ₦500.", 
          show_alert: true 
        });
        return;
      }
      
      withdrawStates[userId] = {
        step: "confirm",
        wallet: "naira",
        type: "bank",
        amount: maxAmount,
        fee: fee,
        netAmount: netAmount
      };
      
      return bot.sendMessage(
        chatId,
        `⚠️ Confirm Maximum Withdrawal\n\n` +
        `🏦 Bank: ${user.bankAccount.bankName}\n` +
        `👤 Account: ${user.bankAccount.accountName}\n\n` +
        `💰 Amount: ₦${formatNumber(maxAmount)}\n` +
        `💸 Fee (1.5%): ₦${formatNumber(fee)}\n` +
        `📥 You Receive: ₦${formatNumber(netAmount)}\n\n` +
        `📊 Current Balance: ₦${formatNumber(user.naira)}\n` +
        `📊 New Balance: ₦${formatNumber(user.naira - maxAmount)}\n\n` +
        `Do you want to proceed?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Confirm Withdrawal", callback_data: "confirm_bank_withdraw" }],
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
    }

    if (data === "confirm_bank_withdraw") {
      const state = withdrawStates[userId];
      if (!state || state.step !== "confirm") {
        await bot.answerCallbackQuery(q.id, { text: "Session expired", show_alert: true });
        return;
      }

      const { amount, fee, netAmount } = state;
      
      if (user.naira < amount) {
        await bot.answerCallbackQuery(q.id, { text: "❌ Insufficient balance", show_alert: true });
        return;
      }

      const withdrawalResult = await processRealWithdrawal(
        userId,
        netAmount,
        {
          bankCode: user.bankAccount.bankCode,
          bankName: user.bankAccount.bankName,
          accountNumber: user.bankAccount.accountNumber,
          accountName: user.bankAccount.accountName
        }
      );

      if (!withdrawalResult.success) {
        await bot.answerCallbackQuery(q.id, { 
          text: `❌ Withdrawal failed: ${withdrawalResult.error}`, 
          show_alert: true 
        });
        return;
      }

      delete withdrawStates[userId];
      
      await bot.answerCallbackQuery(q.id, { text: "✅ Withdrawal initiated successfully!", show_alert: true });
      
      try {
        await bot.editMessageText(
          `✅ Withdrawal Initiated!\n\n` +
          `💰 Amount: ₦${formatNumber(amount)}\n` +
          `💸 Fee: ₦${formatNumber(fee)}\n` +
          `📥 Net Sent: ₦${formatNumber(netAmount)}\n\n` +
          `🏦 Bank: ${user.bankAccount.bankName}\n` +
          `👤 Account: ${user.bankAccount.accountName} (${user.bankAccount.accountNumber})\n\n` +
          `📝 Transaction ID: ${withdrawalResult.transferId}\n` +
          `🔢 Reference: ${withdrawalResult.reference}\n\n` +
          `📊 New Balance: ₦${formatNumber(user.naira)}\n` +
          `📈 Daily Withdrawn: ₦${formatNumber(user.dailyWithdrawn)} / ₦${formatNumber(user.dailyWithdrawalLimit)}\n\n` +
          `⏳ Status: Processing\n` +
          `⏰ Funds will arrive within 1-24 hours.\n` +
          `📱 You'll receive a notification when completed.`,
          { 
            chat_id: chatId, 
            message_id: q.message.message_id,
            reply_markup: {
              inline_keyboard: [
                [{ text: "📋 View Transaction", callback_data: `view_tx_${withdrawalResult.transactionId}` }],
                [{ text: "📊 Check Status", callback_data: `check_status_${withdrawalResult.transferId}` }],
                [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
              ]
            }
          }
        );
      } catch (error) {
        await bot.sendMessage(
          chatId,
          `✅ Withdrawal Initiated!\n\n` +
          `💰 Amount: ₦${formatNumber(amount)}\n` +
          `💸 Fee: ₦${formatNumber(fee)}\n` +
          `📥 Net Sent: ₦${formatNumber(netAmount)}\n\n` +
          `🏦 Bank: ${user.bankAccount.bankName}\n` +
          `👤 Account: ${user.bankAccount.accountName} (${user.bankAccount.accountNumber})\n\n` +
          `📝 Transaction ID: ${withdrawalResult.transferId}\n` +
          `🔢 Reference: ${withdrawalResult.reference}\n\n` +
          `📊 New Balance: ₦${formatNumber(user.naira)}\n` +
          `📈 Daily Withdrawn: ₦${formatNumber(user.dailyWithdrawn)} / ₦${formatNumber(user.dailyWithdrawalLimit)}\n\n` +
          `⏳ Status: Processing\n` +
          `⏰ Funds will arrive within 1-24 hours.\n` +
          `📱 You'll receive a notification when completed.`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "📋 View Transaction", callback_data: `view_tx_${withdrawalResult.transactionId}` }],
                [{ text: "📊 Check Status", callback_data: `check_status_${withdrawalResult.transferId}` }],
                [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
              ]
            }
          }
        );
      }
      return;
    }

    // VIEW TRANSACTION
    if (data.startsWith("view_tx_")) {
      const txId = data.replace("view_tx_", "");
      const transaction = user.transactions.find(tx => tx.id === txId);
      
      if (!transaction) {
        await bot.answerCallbackQuery(q.id, { text: "Transaction not found", show_alert: true });
        return;
      }
      
      let txDetails = `📋 Transaction Details\n\n`;
      txDetails += `ID: ${transaction.id}\n`;
      txDetails += `Type: ${transaction.type.replace('_', ' ').toUpperCase()}\n`;
      txDetails += `Amount: ${formatNumber(transaction.amount)} ${transaction.currency}\n`;
      txDetails += `Status: ${transaction.status.toUpperCase()}\n`;
      txDetails += `Date: ${new Date(transaction.timestamp).toLocaleString()}\n`;
      
      if (transaction.details) {
        txDetails += `\n📄 Details:\n`;
        Object.entries(transaction.details).forEach(([key, value]) => {
          if (key !== 'providerResponse') {
            txDetails += `${key}: ${value}\n`;
          }
        });
      }
      
      if (transaction.completedAt) {
        txDetails += `Completed: ${new Date(transaction.completedAt).toLocaleString()}\n`;
      }
      
      return bot.sendMessage(
        chatId,
        txDetails,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
            ]
          }
        }
      );
    }

    // CHECK TRANSFER STATUS
    if (data.startsWith("check_status_")) {
      const transferId = data.replace("check_status_", "");
      
      const status = await paymentProcessor.checkTransferStatus(transferId);
      
      if (!status) {
        return bot.sendMessage(
          chatId,
          "❌ Unable to check status at this time. Please try again later.",
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
              ]
            }
          }
        );
      }
      
      const statusData = status.data;
      let statusMsg = `📊 Transfer Status\n\n`;
      statusMsg += `ID: ${statusData.id}\n`;
      statusMsg += `Amount: ₦${formatNumber(statusData.amount)}\n`;
      statusMsg += `Status: ${statusData.status.toUpperCase()}\n`;
      statusMsg += `Reference: ${statusData.reference}\n`;
      statusMsg += `Bank: ${statusData.bank_name}\n`;
      statusMsg += `Account: ${statusData.account_number}\n`;
      statusMsg += `Name: ${statusData.full_name}\n`;
      statusMsg += `Narration: ${statusData.narration}\n`;
      
      if (statusData.created_at) {
        statusMsg += `Initiated: ${new Date(statusData.created_at).toLocaleString()}\n`;
      }
      
      if (statusData.complete_message) {
        statusMsg += `\n💬 Message: ${statusData.complete_message}\n`;
      }
      
      return bot.sendMessage(
        chatId,
        statusMsg,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Refresh", callback_data: `check_status_${transferId}` }],
              [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
            ]
          }
        }
      );
    }

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

  console.log(`📱 Message from ${userId}: ${text}`);

  if (!text) return;

  try {
    // Handle start command with referral
    if (text.startsWith('/start')) {
      const parts = text.split(' ');
      const referralCode = parts[1];
      let referredBy = null;
      
      if (referralCode && referralCodes[referralCode]) {
        referredBy = referralCodes[referralCode];
      }
      
      const user = initUser(userId, referredBy);
      
      let welcomeMsg = `👋 Welcome to ${BUSINESS_NAME} Bot!\n\n`;
      
      if (referredBy) {
        welcomeMsg += `🎉 You joined using a referral link!\n`;
        welcomeMsg += `💰 You received ₦500 bonus in your Naira wallet!\n\n`;
        users[userId].naira += 500;
      }
      
      welcomeMsg += `✨ *Complete Features:*\n`;
      welcomeMsg += `✅ Real Bank Withdrawals (via Flutterwave)\n`;
      welcomeMsg += `✅ Crypto Wallets (BTC, ETH, SOL, USDT)\n`;
      welcomeMsg += `✅ Bank Account Management\n`;
      welcomeMsg += `✅ Crypto Swaps (6 pairs)\n`;
      welcomeMsg += `✅ Referral System\n`;
      welcomeMsg += `✅ Live Exchange Rates\n\n`;
      welcomeMsg += `💡 *Tip:* Add your bank account first to enable withdrawals!\n\n`;
      welcomeMsg += `⚠️ *Important:*\n`;
      welcomeMsg += `• Minimum withdrawal: ₦500\n`;
      welcomeMsg += `• Fee: 1.5% (min ₦50)\n`;
      welcomeMsg += `• Daily limit: ₦500,000\n`;
      welcomeMsg += `• KYC required above ₦100,000`;
      
      return bot.sendMessage(chatId, welcomeMsg, { 
        parse_mode: 'Markdown',
        ...defaultKeyboard 
      });
    }

    const user = initUser(userId);
    const withdrawState = withdrawStates[userId];
    const swapState = swapStates[userId];
    const bankState = bankAccountStates[userId];

    // ===============================
    // SWAP AMOUNT INPUT
    // ===============================
    if (swapState && swapState.step === "amount") {
      const { swapType } = swapState;
      const [from, to] = swapType.split("_to_");
      const amount = parseFloat(text);
      
      if (isNaN(amount) || amount <= 0) {
        return bot.sendMessage(chatId, "❌ Please enter a valid number");
      }
      
      if (amount > user[from]) {
        return bot.sendMessage(
          chatId,
          `❌ Insufficient balance!\nAvailable: ${formatNumber(user[from], from === 'usdt' ? 2 : 8)} ${from.toUpperCase()}`
        );
      }

      const rates = await fetchRates();
      const fromRate = from === 'usdt' ? 1 : rates[from].usd;
      const toRate = to === 'usdt' ? 1 : rates[to].usd;
      
      const swapResult = calculateSwap(amount, fromRate, toRate);
      
      swapStates[userId] = {
        step: "confirm",
        swapType,
        amount,
        received: swapResult.received,
        fee: swapResult.fee
      };

      return bot.sendMessage(
        chatId,
        `🔄 Confirm Swap\n\n` +
        `📤 Sent: ${formatNumber(amount, from === 'usdt' ? 2 : 8)} ${from.toUpperCase()}\n` +
        `📥 Receive: ${formatNumber(swapResult.received, to === 'usdt' ? 2 : 8)} ${to.toUpperCase()}\n` +
        `💰 Fee: ${formatNumber(swapResult.fee, from === 'usdt' ? 2 : 8)} ${from.toUpperCase()} (${swapResult.feePercent}%)\n\n` +
        `💱 Rate: 1 ${from.toUpperCase()} = ${formatNumber(swapResult.received / amount, 8)} ${to.toUpperCase()}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Confirm Swap", callback_data: "confirm_swap" }],
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
    }

    // ===============================
    // CRYPTO WITHDRAWAL AMOUNT INPUT
    // ===============================
    if (withdrawState && withdrawState.step === "amount" && withdrawState.type !== "bank") {
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

      const rates = await fetchRates();
      const ngnAmount = amount * rates[wallet].ngn;

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

    // ===============================
    // BANK ACCOUNT SETUP FLOW
    // ===============================
    if (bankState) {
      if (bankState.step === "enter_account_number") {
        const accountNumber = text.trim();
        
        if (!validateAccountNumber(accountNumber)) {
          return bot.sendMessage(
            chatId,
            "❌ Invalid account number. Please enter a valid 10-digit account number:",
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "❌ Cancel", callback_data: "cancel_action" }]
                ]
              }
            }
          );
        }
        
        bankState.accountNumber = accountNumber;
        bankState.step = "enter_account_name";
        
        return bot.sendMessage(
          chatId,
          `✅ Account number accepted!\n\nNow enter the account name (as it appears on your bank statement):`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Cancel", callback_data: "cancel_action" }]
              ]
            }
          }
        );
      }
      
      if (bankState.step === "enter_account_name") {
        const accountName = text.trim();
        
        if (!validateAccountName(accountName)) {
          return bot.sendMessage(
            chatId,
            "❌ Invalid account name. Please enter your full name (at least 2 words):",
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "❌ Cancel", callback_data: "cancel_action" }]
                ]
              }
            }
          );
        }
        
        await bot.sendMessage(chatId, "🔄 Verifying account with bank...");
        
        const verification = await paymentProcessor.verifyBankAccount(
          bankState.accountNumber,
          bankState.bankCode
        );
        
        if (!verification.success) {
          return bot.sendMessage(
            chatId,
            `❌ Account verification failed:\n${verification.error}\n\nPlease check your details and try again.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🔄 Try Again", callback_data: "add_bank_account" }],
                  [{ text: "❌ Cancel", callback_data: "cancel_action" }]
                ]
              }
            }
          );
        }
        
        const providedName = accountName.toLowerCase().replace(/\s+/g, ' ');
        const verifiedName = verification.accountName.toLowerCase().replace(/\s+/g, ' ');
        
        if (providedName !== verifiedName) {
          return bot.sendMessage(
            chatId,
            `❌ Account name doesn't match!\n\n` +
            `You entered: ${accountName}\n` +
            `Bank records: ${verification.accountName}\n\n` +
            `Please enter the exact name on your bank account:`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "❌ Cancel", callback_data: "cancel_action" }]
                ]
              }
            }
          );
        }
        
        user.bankAccount = {
          bankCode: bankState.bankCode,
          bankName: bankState.bankName,
          accountNumber: bankState.accountNumber,
          accountName: verification.accountName,
          addedAt: new Date().toISOString(),
          verified: true,
          lastVerified: new Date().toISOString()
        };
        
        delete bankAccountStates[userId];
        
        return bot.sendMessage(
          chatId,
          `✅ Bank Account Verified & Added Successfully!\n\n` +
          `🏦 Bank: ${user.bankAccount.bankName}\n` +
          `🔢 Account Number: ${user.bankAccount.accountNumber}\n` +
          `👤 Account Name: ${user.bankAccount.accountName}\n\n` +
          `✅ Account verified with bank\n` +
          `✅ Ready for withdrawals\n\n` +
          `💰 You can now withdraw funds to this account!`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "💰 Withdraw Now", callback_data: "withdraw_naira" }],
                [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
              ]
            }
          }
        );
      }
      
      // Update flow
      if (bankState.step === "enter_account_number_update") {
        const accountNumber = text.trim();
        
        if (!validateAccountNumber(accountNumber)) {
          return bot.sendMessage(
            chatId,
            "❌ Invalid account number. Please enter a valid 10-digit account number:",
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "❌ Cancel", callback_data: "cancel_action" }]
                ]
              }
            }
          );
        }
        
        bankState.accountNumber = accountNumber;
        bankState.step = "enter_account_name_update";
        
        return bot.sendMessage(
          chatId,
          `✅ Account number accepted!\n\nNow enter the new account name:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Cancel", callback_data: "cancel_action" }]
              ]
            }
          }
        );
      }
      
      if (bankState.step === "enter_account_name_update") {
        const accountName = text.trim();
        
        if (!validateAccountName(accountName)) {
          return bot.sendMessage(
            chatId,
            "❌ Invalid account name. Please enter your full name (at least 2 words):",
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "❌ Cancel", callback_data: "cancel_action" }]
                ]
              }
            }
          );
        }
        
        await bot.sendMessage(chatId, "🔄 Verifying account with bank...");
        
        const verification = await paymentProcessor.verifyBankAccount(
          bankState.accountNumber,
          bankState.bankCode
        );
        
        if (!verification.success) {
          return bot.sendMessage(
            chatId,
            `❌ Account verification failed:\n${verification.error}\n\nPlease check your details and try again.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🔄 Try Again", callback_data: "update_bank_account" }],
                  [{ text: "❌ Cancel", callback_data: "cancel_action" }]
                ]
              }
            }
          );
        }
        
        const providedName = accountName.toLowerCase().replace(/\s+/g, ' ');
        const verifiedName = verification.accountName.toLowerCase().replace(/\s+/g, ' ');
        
        if (providedName !== verifiedName) {
          return bot.sendMessage(
            chatId,
            `❌ Account name doesn't match!\n\n` +
            `You entered: ${accountName}\n` +
            `Bank records: ${verification.accountName}\n\n` +
            `Please enter the exact name on your bank account:`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "❌ Cancel", callback_data: "cancel_action" }]
                ]
              }
            }
          );
        }
        
        user.bankAccount = {
          bankCode: bankState.bankCode,
          bankName: bankState.bankName,
          accountNumber: bankState.accountNumber,
          accountName: verification.accountName,
          addedAt: new Date().toISOString(),
          verified: true,
          lastVerified: new Date().toISOString()
        };
        
        delete bankAccountStates[userId];
        
        return bot.sendMessage(
          chatId,
          `✅ Bank Account Updated & Verified!\n\n` +
          `🏦 Bank: ${user.bankAccount.bankName}\n` +
          `🔢 Account Number: ${user.bankAccount.accountNumber}\n` +
          `👤 Account Name: ${user.bankAccount.accountName}\n\n` +
          `Your bank details have been updated and verified.`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "💰 Withdraw Now", callback_data: "withdraw_naira" }],
                [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
              ]
            }
          }
        );
      }
    }

    // ===============================
    // BANK WITHDRAWAL FLOW
    // ===============================
    if (withdrawState && withdrawState.step === "amount" && withdrawState.type === "bank") {
      const amount = parseFloat(text.replace(/[₦,]/g, ''));
      
      if (isNaN(amount) || amount <= 0) {
        return bot.sendMessage(chatId, "❌ Please enter a valid amount (e.g., 5000 or ₦5,000)");
      }
      
      if (amount > user.naira) {
        return bot.sendMessage(
          chatId,
          `❌ Insufficient balance!\nAvailable: ₦${formatNumber(user.naira)}`
        );
      }
      
      const feePercentage = 0.015;
      const calculatedFee = amount * feePercentage;
      const fee = Math.max(calculatedFee, 50);
      const netAmount = amount - fee;
      
      if (netAmount < 500) {
        return bot.sendMessage(
          chatId,
          `❌ Minimum withdrawal is ₦500 after fees.\n\n` +
          `Amount: ₦${formatNumber(amount)}\n` +
          `Fee: ₦${formatNumber(fee)}\n` +
          `Net: ₦${formatNumber(netAmount)}\n\n` +
          `Please enter a larger amount (at least ₦550).`
        );
      }
      
      const limitCheck = checkWithdrawalLimit(userId, amount);
      if (!limitCheck.allowed) {
        return bot.sendMessage(
          chatId,
          `❌ ${limitCheck.reason}\n\n` +
          `Daily Limit: ₦${formatNumber(user.dailyWithdrawalLimit)}\n` +
          `Used Today: ₦${formatNumber(user.dailyWithdrawn)}\n` +
          `Remaining: ₦${formatNumber(limitCheck.remaining)}`
        );
      }
      
      withdrawState.step = "confirm";
      withdrawState.amount = amount;
      withdrawState.fee = fee;
      withdrawState.netAmount = netAmount;
      
      return bot.sendMessage(
        chatId,
        `⚠️ Confirm Bank Withdrawal\n\n` +
        `🏦 Bank: ${user.bankAccount.bankName}\n` +
        `👤 Account: ${user.bankAccount.accountName} (${user.bankAccount.accountNumber})\n\n` +
        `💰 Amount: ₦${formatNumber(amount)}\n` +
        `💸 Fee (1.5%): ₦${formatNumber(fee)}\n` +
        `📥 You Receive: ₦${formatNumber(netAmount)}\n\n` +
        `📊 Current Balance: ₦${formatNumber(user.naira)}\n` +
        `📊 New Balance: ₦${formatNumber(user.naira - amount)}\n\n` +
        `📈 Limits:\n` +
        `• Daily Used: ₦${formatNumber(user.dailyWithdrawn)}\n` +
        `• Daily Remaining: ₦${formatNumber(limitCheck.remaining)}\n\n` +
        `Do you want to proceed?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Confirm Withdrawal", callback_data: "confirm_bank_withdraw" }],
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
    }

    // ===============================
    // MAIN MENU COMMANDS
    // ===============================
    switch (text) {
      case "🏦 Bank Account":
        return bot.sendMessage(
          chatId,
          `🏦 Bank Account Management\n\n` +
          `Manage your bank details for withdrawals.\n\n` +
          `Status: ${user.bankAccount ? '✅ Verified' : '❌ Not Added'}\n` +
          `Withdrawals: ${user.bankAccount ? '✅ Enabled' : '❌ Add bank first'}\n\n` +
          `Select an option:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "➕ Add Bank Account", callback_data: "add_bank_account" }],
                [{ text: "👁️ View Bank Details", callback_data: "view_bank_details" }],
                [{ text: "✏️ Update Bank Account", callback_data: "update_bank_account" }],
                [{ text: "❌ Remove Bank Account", callback_data: "remove_bank_account" }],
                [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
              ]
            }
          }
        );

      case "💰 Naira Wallet":
        const limitCheck = checkWithdrawalLimit(userId, 0);
        const nairaMsg = `💰 Naira Wallet\n\n` +
          `Balance: ₦${formatNumber(user.naira)}\n` +
          `Bank Account: ${user.bankAccount ? '✅ Verified' : '❌ Not Added'}\n\n` +
          `📊 Withdrawal Limits:\n` +
          `• Daily Limit: ₦${formatNumber(user.dailyWithdrawalLimit)}\n` +
          `• Used Today: ₦${formatNumber(user.dailyWithdrawn)}\n` +
          `• Remaining: ₦${formatNumber(limitCheck.remaining)}\n` +
          `• KYC Verified: ${user.kycVerified ? '✅ Yes' : '❌ No'}\n\n`;
        
        if (user.bankAccount) {
          return bot.sendMessage(
            chatId,
            nairaMsg + `What would you like to do?`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "💸 Withdraw to Bank", callback_data: "withdraw_naira" }],
                  [{ text: "🏦 Bank Details", callback_data: "view_bank_details" }],
                  [{ text: "📥 Deposit Naira", callback_data: "deposit_naira" }],
                  [{ text: "📋 Transaction History", callback_data: "view_transactions" }],
                  [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
                ]
              }
            }
          );
        } else {
          return bot.sendMessage(
            chatId,
            nairaMsg + `To withdraw funds, you need to add a bank account first.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "➕ Add Bank Account", callback_data: "add_bank_account" }],
                  [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
                ]
              }
            }
          );
        }

      case "₿ BTC Wallet":
        const btcRates = await fetchRates();
        return bot.sendMessage(
          chatId,
          `₿ BTC Wallet\n\n` +
          `Balance: ${formatNumber(user.btc, 8)} BTC\n` +
          `Value: ₦${formatNumber(user.btc * btcRates.btc.ngn)}\n` +
          `Rate: ₦${formatNumber(btcRates.btc.ngn)} per BTC`,
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
          `Value: ₦${formatNumber(user.eth * ethRates.eth.ngn)}\n` +
          `Rate: ₦${formatNumber(ethRates.eth.ngn)} per ETH`,
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
          `Value: ₦${formatNumber(user.sol * solRates.sol.ngn)}\n` +
          `Rate: ₦${formatNumber(solRates.sol.ngn)} per SOL`,
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
          `Value: ₦${formatNumber(user.usdt * usdtRates.usdt.ngn)}\n` +
          `Rate: ₦${formatNumber(usdtRates.usdt.ngn)} per USDT`,
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

      case "🔄 Swap Crypto":
        return bot.sendMessage(
          chatId,
          `🔄 Crypto Swap\n\n` +
          `Trade between cryptocurrencies instantly!\n` +
          `Fee: 0.5% per transaction\n\n` +
          `Select a swap pair:`,
          swapKeyboard
        );

      case "BTC → USDT":
        return bot.sendMessage(
          chatId,
          `🔄 BTC to USDT Swap\n\n` +
          `Available: ${formatNumber(user.btc, 8)} BTC\n` +
          `Rate will be calculated when you enter amount\n\n` +
          `Enter amount of BTC to swap:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Start Swap", callback_data: "swap_btc_to_usdt" }],
                [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
              ]
            }
          }
        );

      case "ETH → USDT":
        return bot.sendMessage(
          chatId,
          `🔄 ETH to USDT Swap\n\n` +
          `Available: ${formatNumber(user.eth, 8)} ETH\n` +
          `Enter amount of ETH to swap:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Start Swap", callback_data: "swap_eth_to_usdt" }],
                [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
              ]
            }
          }
        );

      case "SOL → USDT":
        return bot.sendMessage(
          chatId,
          `🔄 SOL to USDT Swap\n\n` +
          `Available: ${formatNumber(user.sol, 8)} SOL\n` +
          `Enter amount of SOL to swap:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Start Swap", callback_data: "swap_sol_to_usdt" }],
                [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
              ]
            }
          }
        );

      case "USDT → BTC":
        return bot.sendMessage(
          chatId,
          `🔄 USDT to BTC Swap\n\n` +
          `Available: ${formatNumber(user.usdt, 2)} USDT\n` +
          `Enter amount of USDT to swap:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Start Swap", callback_data: "swap_usdt_to_btc" }],
                [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
              ]
            }
          }
        );

      case "USDT → ETH":
        return bot.sendMessage(
          chatId,
          `🔄 USDT to ETH Swap\n\n` +
          `Available: ${formatNumber(user.usdt, 2)} USDT\n` +
          `Enter amount of USDT to swap:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Start Swap", callback_data: "swap_usdt_to_eth" }],
                [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
              ]
            }
          }
        );

      case "USDT → SOL":
        return bot.sendMessage(
          chatId,
          `🔄 USDT to SOL Swap\n\n` +
          `Available: ${formatNumber(user.usdt, 2)} USDT\n` +
          `Enter amount of USDT to swap:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Start Swap", callback_data: "swap_usdt_to_sol" }],
                [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
              ]
            }
          }
        );

      case "🎁 Refer and Earn":
        return bot.sendMessage(
          chatId,
          `🎁 Refer and Earn\n\n` +
          `💰 Your Referral Code: ${user.referralCode}\n` +
          `👥 Total Referrals: ${user.referrals.length}\n` +
          `🎯 Total Earnings: ₦${formatNumber(user.referralRewards)}\n\n` +
          `✨ Referral Rewards:\n` +
          `• You earn ₦100 per referral\n` +
          `• Your friend gets ₦500 bonus\n` +
          `• No limit on earnings!\n\n` +
          `What would you like to do?`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "📤 Share Referral Link", callback_data: "share_referral" }],
                [{ text: "👥 My Referrals", callback_data: "my_referrals" }],
                [{ text: "💰 Claim Rewards", callback_data: "claim_rewards" }],
                [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
              ]
            }
          }
        );

      case "📊 View Rates":
        try {
          const rates = await fetchRates();
          const rateMessage = 
            `📊 *Live Exchange Rates*\n\n` +
            `*🌐 USD/NGN RATES*\n` +
            `💵 BUY: ₦${formatNumber(rates.usd_ngn.buy)} per $1\n` +
            `💰 SELL: ₦${formatNumber(rates.usd_ngn.sell)} per $1\n\n` +
            `*💎 CRYPTOCURRENCIES*\n` +
            `₿ BTC: ₦${formatNumber(rates.btc.ngn)} ($${formatNumber(rates.btc.usd)})\n` +
            `💵 ETH: ₦${formatNumber(rates.eth.ngn)} ($${formatNumber(rates.eth.usd)})\n` +
            `🟣 SOL: ₦${formatNumber(rates.sol.ngn)} ($${formatNumber(rates.sol.usd)})\n` +
            `🌐 USDT: ₦${formatNumber(rates.usdt.ngn)} ($${formatNumber(rates.usdt.usd)})\n\n` +
            `📈 *Spread Information:*\n` +
            `• USD/NGN spread: ₦${formatNumber(rates.usd_ngn.sell - rates.usd_ngn.buy)}\n` +
            `• Crypto rates update every 5 minutes\n` +
            `• USD/NGN rates are fixed\n\n` +
            `_Last updated: ${new Date().toLocaleTimeString()}_`;
          
          return bot.sendMessage(chatId, rateMessage, { 
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Refresh Rates", callback_data: "refresh_rates" }],
                [{ text: "⬅️ Back to Menu", callback_data: "back_to_menu" }]
              ]
            }
          });
        } catch (error) {
          console.error("Error fetching rates:", error);
          return bot.sendMessage(chatId, "❌ Unable to fetch rates. Please try again.");
        }

      case "ℹ️ How to Use":
        return bot.sendMessage(
          chatId,
          `ℹ️ How to Use ${BUSINESS_NAME} Bot\n\n` +
          `1. *Check Balances*: Tap any wallet button\n` +
          `2. *Withdraw*: Add bank account, then withdraw Naira\n` +
          `3. *Swap Crypto*: Use "🔄 Swap Crypto" menu\n` +
          `4. *Refer & Earn*: Share your referral link\n` +
          `5. *View Rates*: Get live exchange rates\n\n` +
          `💰 *Withdrawal Information:*\n` +
          `• Minimum: ₦500\n` +
          `• Fee: 1.5% (minimum ₦50)\n` +
          `• Daily Limit: ₦500,000\n` +
          `• Processing: 1-24 hours\n\n` +
          `🔄 *Swap Features:*\n` +
          `• BTC ↔ USDT\n` +
          `• ETH ↔ USDT\n` +
          `• SOL ↔ USDT\n` +
          `• 0.5% transaction fee\n\n` +
          `🎁 *Referral Program:*\n` +
          `• Earn ₦100 per referral\n` +
          `• Friends get ₦500 bonus\n` +
          `• Unlimited earnings!\n\n` +
          `⚠️ *Important Notes:*\n` +
          `• Bank accounts are verified with Flutterwave\n` +
          `• Withdrawals are processed via Flutterwave\n` +
          `• Rates update every 5 minutes\n` +
          `• KYC required for large withdrawals\n\n` +
          `📞 Support: @YourSupportChannel\n` +
          `⚠️ Always verify rates before trading`,
          { parse_mode: 'Markdown' }
        );

      case "⬅️ Back to Main Menu":
        delete swapStates[userId];
        return bot.sendMessage(chatId, "🏠 Main Menu", defaultKeyboard);

      default:
        return bot.sendMessage(chatId, "❌ Please use the menu buttons below", defaultKeyboard);
    }
  } catch (error) {
    console.error("Message handling error:", error);
    console.error("Stack trace:", error.stack);
    return bot.sendMessage(chatId, "❌ An error occurred. Please try again.", defaultKeyboard);
  }
}

// ===============================
// EXPRESS SETUP
// ===============================

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: `${BUSINESS_NAME} Trade Bot`,
    users: Object.keys(users).length,
    bankAccounts: Object.keys(users).filter(id => users[id].bankAccount).length,
    uptime: process.uptime(),
    provider: "Flutterwave",
    withdrawalEnabled: !!FLW_SECRET_KEY
  });
});

// Debug endpoint to check webhook
app.get("/debug", async (req, res) => {
  try {
    const info = await bot.getWebHookInfo();
    res.json({
      webhook: {
        url: info.url,
        pending_updates: info.pending_update_count,
        last_error: info.last_error_message,
        last_error_date: info.last_error_date
      },
      bot: {
        username: (await bot.getMe()).username,
        id: (await bot.getMe()).id
      },
      environment: {
        repl_slug: process.env.REPL_SLUG,
        repl_owner: process.env.REPL_OWNER,
        webhook_url: webhookUrl
      }
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Webhook endpoint for Telegram
app.post("/webhook", (req, res) => {
  console.log("📥 Webhook received:", req.body);
  
  // Immediately respond to Telegram
  res.sendStatus(200);
  
  // Process asynchronously
  setTimeout(async () => {
    try {
      const update = req.body;
      
      if (update.message) {
        console.log("📱 Processing message:", update.message.text);
        await handleMessage(update.message);
      } else if (update.callback_query) {
        console.log("🔘 Processing callback:", update.callback_query.data);
        await handleCallbackQuery(update.callback_query);
      }
    } catch (error) {
      console.error("❌ Webhook processing error:", error);
    }
  }, 0);
});

// Webhook endpoint for Flutterwave
app.post("/transfer-webhook", async (req, res) => {
  try {
    console.log('💰 Flutterwave webhook received:', req.body.event);
    res.sendStatus(200);
  } catch (error) {
    console.error('💰 Flutterwave webhook error:', error);
    res.sendStatus(500);
  }
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Webhook URL: ${webhookUrl}`);
  
  // Fetch banks on startup
  try {
    NIGERIAN_BANKS = await paymentProcessor.getBanks();
    console.log(`🏦 Loaded ${NIGERIAN_BANKS.length} banks`);
  } catch (error) {
    console.log(`⚠️ Using fallback bank list (${Object.keys(BANK_CODES).length} banks)`);
    NIGERIAN_BANKS = Object.entries(BANK_CODES).map(([name, code]) => ({ name, code }));
  }
  
  // Setup webhook
  const webhookResult = await setupWebhook();
  if (webhookResult) {
    console.log(`🤖 Bot initialized successfully!`);
    console.log(`✨ All Features: ✅`);
    console.log(`  • Real Bank Withdrawals (Flutterwave)`);
    console.log(`  • Bank Account Verification`);
    console.log(`  • Crypto Wallets (BTC, ETH, SOL, USDT, NGN)`);
    console.log(`  • Bank Account Management`);
    console.log(`  • Crypto Swap (6 pairs)`);
    console.log(`  • Referral System`);
    console.log(`  • Live Exchange Rates`);
    console.log(`  • Withdrawal Limits & KYC`);
    
    if (!FLW_SECRET_KEY) {
      console.log(`⚠️ WARNING: FLW_SECRET_KEY not set. Bank withdrawals will fail!`);
    }
  } else {
    console.log(`❌ Bot initialization failed`);
  }
  
  console.log(`🔗 Debug URL: https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co/debug`);
});

// Keep alive for Replit
setInterval(() => {
  const domain = process.env.REPL_SLUG && process.env.REPL_OWNER 
    ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`
    : `http://localhost:${PORT}`;
  
  axios.get(domain)
    .then(() => console.log('🏓 Keep alive ping successful'))
    .catch(err => console.log('🏓 Keep alive ping failed:', err.message));
}, 300000);