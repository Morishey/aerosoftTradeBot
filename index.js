// ===============================
// AEROSOFT TRADE BOT - VERCEL VERSION
// ===============================

// Imports
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");
const { ethers } = require("ethers");
const bip39 = require("bip39");

// Environment validation
const TOKEN = process.env.TELEGRAM_TOKEN;
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const FLW_PUBLIC_KEY = process.env.FLW_PUBLIC_KEY;
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Aerosoft Trade";
const WALLET_MNEMONIC = process.env.WALLET_MNEMONIC;
const VERCEL_URL = process.env.VERCEL_URL;

if (!TOKEN) {
  console.error("❌ Missing TELEGRAM_TOKEN");
  process.exit(1);
}

// Initialize Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Initialize Telegram bot
const bot = new TelegramBot(TOKEN, { 
  polling: false,
  request: {
    timeout: 60000,
    agentOptions: {
      keepAlive: true,
      keepAliveMsecs: 60000
    }
  }
});

// Determine webhook URL
let webhookUrl;
if (VERCEL_URL) {
  webhookUrl = `${VERCEL_URL}/api/webhook`;
  console.log(`🌐 Webhook URL: ${webhookUrl}`);
} else {
  console.log("⚠️ VERCEL_URL not set");
  webhookUrl = null;
}

// ===============================
// HD WALLET SYSTEM
// ===============================
class HDWalletSystem {
  constructor() {
    if (!WALLET_MNEMONIC) {
      console.warn("⚠️ WALLET_MNEMONIC not set. Generating new master wallet...");
      this.mnemonic = bip39.generateMnemonic();
      console.log(`📝 NEW MASTER MNEMONIC (SAVE THIS!): ${this.mnemonic}`);
    } else {
      this.mnemonic = WALLET_MNEMONIC;
      console.log(`✅ Loaded existing master wallet`);
    }
    
    // Ethers v5 syntax (compatible with bip39)
    this.masterNode = ethers.utils.HDNode.fromMnemonic(this.mnemonic);
    this.userAddresses = new Map();
    this.addressToUser = new Map();
    
    console.log(`💰 Master Wallet: ${this.masterNode.address}`);
  }
  
  getUserDepositAddress(userId, cryptoType) {
    if (!this.userAddresses.has(userId)) {
      this.userAddresses.set(userId, {});
    }
    
    const userWallets = this.userAddresses.get(userId);
    
    if (!userWallets[cryptoType]) {
      const path = this.getDerivationPath(userId, cryptoType);
      const derivedNode = this.masterNode.derivePath(path);
      
      userWallets[cryptoType] = {
        address: derivedNode.address,
        path: path,
        created: new Date().toISOString()
      };
      
      this.addressToUser.set(derivedNode.address.toLowerCase(), {
        userId: userId,
        cryptoType: cryptoType
      });
    }
    
    return userWallets[cryptoType].address;
  }
  
  getDerivationPath(userId, cryptoType) {
    const userIdNum = this.hashUserId(userId);
    
    const paths = {
      'btc': `m/44'/0'/0'/0/${userIdNum}`,
      'eth': `m/44'/60'/0'/0/${userIdNum}`,
      'usdt': `m/44'/60'/0'/0/${userIdNum}`,
      'sol': `m/44'/501'/0'/0'/${userIdNum}`,
    };
    
    return paths[cryptoType] || paths['eth'];
  }
  
  hashUserId(userId) {
    const str = userId.toString();
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash % 1000000);
  }
  
  getUserByAddress(address) {
    return this.addressToUser.get(address.toLowerCase());
  }
}

// ===============================
// PAYMENT PROCESSOR
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
      console.error('Account verification failed:', error.response?.data?.message || error.message);
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
        beneficiary_name: recipient.accountName
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
      console.error('Transfer failed:', error.response?.data?.message || error.message);
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
      console.log("🏦 Fetching banks from Flutterwave...");
      const response = await axios.get(
        `${this.baseURL}/banks/NG`,
        { headers: this.headers, timeout: 10000 }
      );
      
      console.log(`✅ Successfully loaded ${response.data.data.length} banks`);
      return response.data.data.map(bank => ({
        name: bank.name,
        code: bank.code,
        id: bank.id
      }));
    } catch (error) {
      console.error('❌ Failed to fetch banks:', error.message);
      // Fallback banks
      return [
        { name: "Access Bank", code: "044", id: "044" },
        { name: "First Bank", code: "011", id: "011" },
        { name: "GT Bank", code: "058", id: "058" },
        { name: "UBA", code: "033", id: "033" },
        { name: "Zenith Bank", code: "057", id: "057" }
      ];
    }
  }
}

// ===============================
// INITIALIZE SYSTEMS
// ===============================
const walletSystem = new HDWalletSystem();
const paymentProcessor = new PaymentProcessor();

// ===============================
// STATE STORAGE
// ===============================
const users = {};
const withdrawStates = {};
const swapStates = {};
const referralCodes = {};
const bankAccountStates = {};
let NIGERIAN_BANKS = [];

// ===============================
// HELPER FUNCTIONS
// ===============================
function initUser(userId, referredBy = null) {
  if (!users[userId]) {
    users[userId] = { 
      naira: 10000, 
      btc: 0.01, 
      eth: 0.1, 
      sol: 1, 
      usdt: 10,
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
      lastWithdrawalDate: null,
      depositAddresses: {},
      lastDepositCheck: null
    };
    
    ['btc', 'eth', 'sol', 'usdt'].forEach(crypto => {
      users[userId].depositAddresses[crypto] = walletSystem.getUserDepositAddress(userId, crypto);
    });
    
    if (referredBy && users[referredBy]) {
      users[referredBy].referrals.push({
        userId: userId,
        date: new Date().toISOString(),
        bonus: 100
      });
      users[referredBy].referralRewards += 100;
      users[referredBy].naira += 100;
      
      users[userId].naira += 500;
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
  
  user.naira -= amount;
  user.totalWithdrawn += amount;
  user.dailyWithdrawn += amount;
  user.lastWithdrawalDate = new Date().toDateString();
  
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
    user.naira += amount;
    user.totalWithdrawn -= amount;
    user.dailyWithdrawn -= amount;
    
    return {
      success: false,
      error: transferResult.error
    };
  }
  
  return {
    success: true,
    transactionId: Date.now().toString(),
    reference: reference,
    transferId: transferResult.transferId,
    amount: amount
  };
}

function getDepositInstructions(cryptoType, address) {
  const instructions = {
    btc: {
      network: "Bitcoin (BTC)",
      min: "0.0001 BTC",
      confirms: "3 confirmations",
      note: "Send only BTC to this address",
      explorer: `https://blockstream.info/address/${address}`
    },
    eth: {
      network: "Ethereum (ERC20)",
      min: "0.01 ETH",
      confirms: "12 confirmations",
      note: "Send only ETH to this address",
      explorer: `https://etherscan.io/address/${address}`
    },
    sol: {
      network: "Solana",
      min: "0.1 SOL",
      confirms: "1 confirmation",
      note: "Send only SOL to this address",
      explorer: `https://solscan.io/account/${address}`
    },
    usdt: {
      network: "ERC20 (Ethereum)",
      min: "10 USDT",
      confirms: "12 confirmations",
      note: "Send only USDT (ERC20) to this address",
      explorer: `https://etherscan.io/address/${address}`
    }
  };
  
  return instructions[cryptoType] || instructions.eth;
}

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

// ===============================
// MESSAGE HANDLER
// ===============================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text?.trim();

  if (!text) return;

  try {
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
      }
      
      welcomeMsg += `✨ *Complete Features:*\n`;
      welcomeMsg += `✅ Real Bank Withdrawals (via Flutterwave)\n`;
      welcomeMsg += `✅ HD Crypto Wallets (Unique addresses)\n`;
      welcomeMsg += `✅ Bank Account Management\n`;
      welcomeMsg += `✅ Crypto Swaps (6 pairs)\n`;
      welcomeMsg += `✅ Referral System\n`;
      welcomeMsg += `✅ Live Exchange Rates\n\n`;
      welcomeMsg += `⚠️ *Important:*\n`;
      welcomeMsg += `• Minimum withdrawal: ₦500\n`;
      welcomeMsg += `• Fee: 1.5% (min ₦50)\n`;
      welcomeMsg += `• Daily limit: ₦500,000`;
      
      return bot.sendMessage(chatId, welcomeMsg, { 
        parse_mode: 'Markdown',
        ...defaultKeyboard 
      });
    }

    const user = initUser(userId);
    const withdrawState = withdrawStates[userId];
    const swapState = swapStates[userId];
    const bankState = bankAccountStates[userId];

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
        `⚠️ Confirm Sale\n\n` +
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

    if (bankState && bankState.step === "enter_account_number") {
      const accountNumber = text.trim();
      
      if (!validateAccountNumber(accountNumber)) {
        return bot.sendMessage(
          chatId,
          "❌ Invalid account number. Please enter a valid 10-digit account number."
        );
      }
      
      bankState.accountNumber = accountNumber;
      bankState.step = "enter_account_name";
      
      return bot.sendMessage(
        chatId,
        `🏦 Account Number: ${accountNumber}\n\nPlease enter the account name as it appears on your bank statement:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
    }

    if (bankState && bankState.step === "enter_account_name") {
      const accountName = text.trim();
      
      if (!validateAccountName(accountName)) {
        return bot.sendMessage(
          chatId,
          "❌ Invalid account name. Please enter your full name (at least 2 words)."
        );
      }
      
      bankState.accountName = accountName;
      
      const verifyMsg = await bot.sendMessage(
        chatId,
        "🔍 Verifying your bank account details...",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
      
      try {
        const verification = await paymentProcessor.verifyBankAccount(
          bankState.accountNumber,
          bankState.bankCode
        );
        
        if (!verification.success) {
          delete bankAccountStates[userId];
          return bot.editMessageText(
            `❌ Account verification failed:\n${verification.error}\n\nPlease try again.`,
            { chat_id: chatId, message_id: verifyMsg.message_id }
          );
        }
        
        const providedName = bankState.accountName.toLowerCase().replace(/\s+/g, ' ');
        const verifiedName = verification.accountName.toLowerCase().replace(/\s+/g, ' ');
        
        if (providedName !== verifiedName) {
          delete bankAccountStates[userId];
          return bot.editMessageText(
            `❌ Account name doesn't match.\n\n` +
            `You entered: ${bankState.accountName}\n` +
            `Bank has: ${verification.accountName}\n\n` +
            `Please try again with the correct account name.`,
            { chat_id: chatId, message_id: verifyMsg.message_id }
          );
        }
        
        user.bankAccount = {
          bankCode: bankState.bankCode,
          bankName: bankState.bankName,
          accountNumber: bankState.accountNumber,
          accountName: verification.accountName,
          verified: true,
          addedAt: new Date().toISOString()
        };
        
        delete bankAccountStates[userId];
        
        return bot.editMessageText(
          `✅ Bank Account Verified Successfully!\n\n` +
          `🏦 Bank: ${bankState.bankName}\n` +
          `📞 Account: ${bankState.accountNumber}\n` +
          `👤 Name: ${verification.accountName}\n\n` +
          `You can now withdraw funds to this account.`,
          {
            chat_id: chatId,
            message_id: verifyMsg.message_id,
            reply_markup: {
              inline_keyboard: [
                [{ text: "💰 Withdraw Now", callback_data: "withdraw_naira" }],
                [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
              ]
            }
          }
        );
        
      } catch (error) {
        console.error("Bank verification error:", error);
        delete bankAccountStates[userId];
        return bot.editMessageText(
          "❌ Failed to verify account. Please try again later.",
          { chat_id: chatId, message_id: verifyMsg.message_id }
        );
      }
    }

    if (withdrawState && withdrawState.step === "amount" && withdrawState.type === "bank") {
      const amount = parseFloat(text.replace(/[₦,]/g, ''));
      
      if (isNaN(amount) || amount <= 0) {
        return bot.sendMessage(chatId, "❌ Please enter a valid amount");
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
          `Please enter at least ₦550.`
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
        `👤 Account: ${user.bankAccount.accountName}\n\n` +
        `💰 Amount: ₦${formatNumber(amount)}\n` +
        `💸 Fee (1.5%): ₦${formatNumber(fee)}\n` +
        `📥 You Receive: ₦${formatNumber(netAmount)}\n\n` +
        `📊 Current Balance: ₦${formatNumber(user.naira)}\n` +
        `📊 New Balance: ₦${formatNumber(user.naira - amount)}\n\n` +
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

    switch (text) {
      case "🏦 Bank Account":
        if (NIGERIAN_BANKS.length === 0) {
          try {
            NIGERIAN_BANKS = await paymentProcessor.getBanks();
          } catch (error) {
            console.error("Failed to load banks:", error);
          }
        }
        
        const bankStatus = user.bankAccount 
          ? `✅ Bank: ${user.bankAccount.bankName}\nAccount: ${user.bankAccount.accountNumber.slice(-4)}`
          : '❌ No bank account added';
        
        return bot.sendMessage(
          chatId,
          `🏦 Bank Account Management\n\n` +
          `Status: ${bankStatus}\n\n` +
          `📊 Available Banks: ${NIGERIAN_BANKS.length} banks\n\n` +
          `Select an option:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "➕ Add Bank Account", callback_data: "add_bank_account" }],
                user.bankAccount ? [{ text: "👁️ View Bank Details", callback_data: "view_bank_details" }] : null,
                user.bankAccount ? [{ text: "💰 Withdraw Now", callback_data: "withdraw_naira" }] : null,
                [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
              ].filter(Boolean)
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
          `• Remaining: ₦${formatNumber(limitCheck.remaining)}\n\n`;
        
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
                  [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
                ]
              }
            }
          );
        } else {
          return bot.sendMessage(
            chatId,
            nairaMsg + `To withdraw funds, add a bank account first.`,
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
        const btcAddress = walletSystem.getUserDepositAddress(userId, 'btc');
        
        return bot.sendMessage(
          chatId,
          `₿ BTC Wallet\n\n` +
          `Balance: ${formatNumber(user.btc, 8)} BTC\n` +
          `Value: ₦${formatNumber(user.btc * btcRates.btc.ngn)}\n` +
          `Rate: ₦${formatNumber(btcRates.btc.ngn)} per BTC\n\n` +
          `📥 Deposit Address:\n\`${btcAddress}\``,
          {
            parse_mode: 'Markdown',
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
        const ethAddress = walletSystem.getUserDepositAddress(userId, 'eth');
        
        return bot.sendMessage(
          chatId,
          `💵 ETH Wallet\n\n` +
          `Balance: ${formatNumber(user.eth, 8)} ETH\n` +
          `Value: ₦${formatNumber(user.eth * ethRates.eth.ngn)}\n` +
          `Rate: ₦${formatNumber(ethRates.eth.ngn)} per ETH\n\n` +
          `📥 Deposit Address:\n\`${ethAddress}\``,
          {
            parse_mode: 'Markdown',
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
        const solAddress = walletSystem.getUserDepositAddress(userId, 'sol');
        
        return bot.sendMessage(
          chatId,
          `🟣 SOL Wallet\n\n` +
          `Balance: ${formatNumber(user.sol, 8)} SOL\n` +
          `Value: ₦${formatNumber(user.sol * solRates.sol.ngn)}\n` +
          `Rate: ₦${formatNumber(solRates.sol.ngn)} per SOL\n\n` +
          `📥 Deposit Address:\n\`${solAddress}\``,
          {
            parse_mode: 'Markdown',
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
        const usdtAddress = walletSystem.getUserDepositAddress(userId, 'usdt');
        
        return bot.sendMessage(
          chatId,
          `🌐 USDT Wallet\n\n` +
          `Balance: ${formatNumber(user.usdt, 2)} USDT\n` +
          `Value: ₦${formatNumber(user.usdt * usdtRates.usdt.ngn)}\n` +
          `Rate: ₦${formatNumber(usdtRates.usdt.ngn)} per USDT\n\n` +
          `📥 Deposit Address:\n\`${usdtAddress}\``,
          {
            parse_mode: 'Markdown',
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
          {
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
          }
        );

      case "BTC → USDT":
        swapStates[userId] = { step: "amount", swapType: "btc_to_usdt" };
        return bot.sendMessage(
          chatId,
          `🔄 BTC to USDT Swap\n\n` +
          `Available: ${formatNumber(user.btc, 8)} BTC\n\n` +
          `Enter amount of BTC to swap:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Cancel", callback_data: "cancel_action" }]
              ]
            }
          }
        );

      case "ETH → USDT":
        swapStates[userId] = { step: "amount", swapType: "eth_to_usdt" };
        return bot.sendMessage(
          chatId,
          `🔄 ETH to USDT Swap\n\n` +
          `Available: ${formatNumber(user.eth, 8)} ETH\n` +
          `Enter amount of ETH to swap:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Cancel", callback_data: "cancel_action" }]
              ]
            }
          }
        );

      case "SOL → USDT":
        swapStates[userId] = { step: "amount", swapType: "sol_to_usdt" };
        return bot.sendMessage(
          chatId,
          `🔄 SOL to USDT Swap\n\n` +
          `Available: ${formatNumber(user.sol, 8)} SOL\n` +
          `Enter amount of SOL to swap:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Cancel", callback_data: "cancel_action" }]
              ]
            }
          }
        );

      case "USDT → BTC":
        swapStates[userId] = { step: "amount", swapType: "usdt_to_btc" };
        return bot.sendMessage(
          chatId,
          `🔄 USDT to BTC Swap\n\n` +
          `Available: ${formatNumber(user.usdt, 2)} USDT\n` +
          `Enter amount of USDT to swap:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Cancel", callback_data: "cancel_action" }]
              ]
            }
          }
        );

      case "USDT → ETH":
        swapStates[userId] = { step: "amount", swapType: "usdt_to_eth" };
        return bot.sendMessage(
          chatId,
          `🔄 USDT to ETH Swap\n\n` +
          `Available: ${formatNumber(user.usdt, 2)} USDT\n` +
          `Enter amount of USDT to swap:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Cancel", callback_data: "cancel_action" }]
              ]
            }
          }
        );

      case "USDT → SOL":
        swapStates[userId] = { step: "amount", swapType: "usdt_to_sol" };
        return bot.sendMessage(
          chatId,
          `🔄 USDT to SOL Swap\n\n` +
          `Available: ${formatNumber(user.usdt, 2)} USDT\n` +
          `Enter amount of USDT to swap:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Cancel", callback_data: "cancel_action" }]
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
          `• Your friend gets ₦500 bonus\n\n` +
          `What would you like to do?`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "📤 Share Referral Link", callback_data: "share_referral" }],
                [{ text: "👥 My Referrals", callback_data: "my_referrals" }],
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
          `2. *Deposit*: Each user gets unique crypto addresses\n` +
          `3. *Withdraw*: Add bank account, then withdraw Naira\n` +
          `4. *Swap Crypto*: Use "🔄 Swap Crypto" menu\n` +
          `5. *Refer & Earn*: Share your referral link\n` +
          `6. *View Rates*: Get live exchange rates\n\n` +
          `💰 *HD Wallet System:*\n` +
          `• Each user gets unique deposit addresses\n` +
          `• All funds go to master wallet\n` +
          `• Perfect tracking of who sent what\n\n` +
          `⚠️ *Important Notes:*\n` +
          `• Bank accounts are verified with Flutterwave\n` +
          `• Withdrawals are processed via Flutterwave\n` +
          `• Minimum withdrawal: ₦500\n` +
          `• Fee: 1.5% (min ₦50)\n\n` +
          `📞 Support: @AerosoftSupport`,
          { parse_mode: 'Markdown' }
        );

      case "⬅️ Back to Main Menu":
        delete swapStates[userId];
        delete withdrawStates[userId];
        delete bankAccountStates[userId];
        return bot.sendMessage(chatId, "🏠 Main Menu", defaultKeyboard);

      default:
        if (text.startsWith("📥 Deposit")) {
          const cryptoMatch = text.match(/📥 Deposit (\w+)/);
          if (cryptoMatch) {
            const cryptoType = cryptoMatch[1].toLowerCase();
            return handleCallbackQuery({
              from: { id: userId },
              message: { chat: { id: chatId } },
              data: `deposit_${cryptoType}`,
              id: `manual_${Date.now()}`
            });
          }
        }
        
        return bot.sendMessage(chatId, "❌ Please use the menu buttons below", defaultKeyboard);
    }
  } catch (error) {
    console.error("Message handling error:", error);
    return bot.sendMessage(chatId, "❌ An error occurred. Please try again.", defaultKeyboard);
  }
}

// ===============================
// CALLBACK QUERY HANDLER
// ===============================
async function handleCallbackQuery(q) {
  const userId = q.from.id;
  const chatId = q.message.chat.id;
  const data = q.data;

  console.log(`🔘 Callback query: ${data}`);

  try {
    await bot.answerCallbackQuery(q.id);

    const user = initUser(userId);

    if (data === "back_to_menu" || data === "cancel_action") {
      delete withdrawStates[userId];
      delete swapStates[userId];
      delete bankAccountStates[userId];
      return bot.sendMessage(chatId, "🏠 Main Menu", defaultKeyboard);
    }

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
        `_Last updated: ${new Date().toLocaleTimeString()}_`;
      
      return bot.editMessageText(rateMessage, {
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
    }

    if (data.startsWith("deposit_")) {
      const cryptoType = data.replace("deposit_", "");
      
      if (cryptoType === "naira") {
        let depositMsg = `📥 Deposit Naira\n\n`;
        depositMsg += `To deposit Naira, please send to:\n`;
        depositMsg += `🏦 Bank: ${BUSINESS_NAME} Bank\n`;
        depositMsg += `📞 Account: 0123456789\n`;
        depositMsg += `👤 Name: ${BUSINESS_NAME} Trade\n\n`;
        depositMsg += `After payment, send proof to @AerosoftSupport`;
        
        return bot.sendMessage(chatId, depositMsg, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
            ]
          }
        });
      } else {
        const userAddress = walletSystem.getUserDepositAddress(userId, cryptoType);
        const instructions = getDepositInstructions(cryptoType, userAddress);
        
        let depositMsg = `📥 Deposit ${cryptoType.toUpperCase()}\n\n`;
        depositMsg += `Your unique deposit address:\n`;
        depositMsg += `\`${userAddress}\`\n\n`;
        depositMsg += `🌐 Network: ${instructions.network}\n`;
        depositMsg += `📦 Minimum: ${instructions.min}\n`;
        depositMsg += `⏱️ Confirms: ${instructions.confirms}\n`;
        depositMsg += `⚠️ ${instructions.note}\n\n`;
        depositMsg += `💰 Your balance will update automatically after confirmation.`;
        
        return bot.sendMessage(chatId, depositMsg, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "📋 Copy Address", callback_data: `copy_address_${cryptoType}` }],
              [{ text: "🔍 View on Explorer", url: instructions.explorer }],
              [{ text: "🔄 Check Balance", callback_data: `check_${cryptoType}_balance` }],
              [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
            ]
          }
        });
      }
    }

    if (data.startsWith("copy_address_")) {
      const cryptoType = data.replace("copy_address_", "");
      await bot.answerCallbackQuery(q.id, { 
        text: `📋 ${cryptoType.toUpperCase()} address copied!`, 
        show_alert: true 
      });
      return;
    }

    if (data.startsWith("check_")) {
      const match = data.match(/check_(.+)_balance/);
      if (match) {
        const cryptoType = match[1];
        const balance = user[cryptoType] || 0;
        await bot.answerCallbackQuery(q.id, { 
          text: `💰 ${cryptoType.toUpperCase()} Balance: ${formatNumber(balance, cryptoType === 'usdt' ? 2 : 8)}`, 
          show_alert: true 
        });
      }
      return;
    }

    if (data === "share_referral") {
      const botUsername = (await bot.getMe()).username;
      const referralLink = `https://t.me/${botUsername}?start=${user.referralCode}`;
      
      return bot.sendMessage(
        chatId,
        `🎁 Share Your Referral Link\n\n` +
        `🔗 ${referralLink}\n\n` +
        `💰 You earn ₦100 for each friend who joins!\n` +
        `🎯 Your friends get ₦500 bonus.\n\n` +
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
      }
      
      return bot.sendMessage(chatId, referralsText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬅️ Back", callback_data: "back_to_referral" }]
          ]
        }
      });
    }

    if (data === "back_to_referral") {
      return bot.sendMessage(
        chatId,
        `🎁 Refer and Earn\n\n` +
        `💰 Your Referral Code: ${user.referralCode}\n` +
        `👥 Total Referrals: ${user.referrals.length}\n` +
        `🎯 Total Earnings: ₦${formatNumber(user.referralRewards)}\n\n` +
        `✨ Referral Rewards:\n` +
        `• You earn ₦100 per referral\n` +
        `• Your friend gets ₦500 bonus\n\n` +
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

    if (data === "claim_rewards") {
      await bot.answerCallbackQuery(q.id, { 
        text: "✅ All rewards are automatically added to your Naira wallet!", 
        show_alert: true 
      });
      return;
    }

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
        
        delete swapStates[userId];
        
        await bot.answerCallbackQuery(q.id, { text: "✅ Swap successful!", show_alert: true });
        
        return bot.editMessageText(
          `✅ Swap Completed!\n\n` +
          `📤 Sent: ${formatNumber(amount, from === 'usdt' ? 2 : 8)} ${from.toUpperCase()}\n` +
          `📥 Received: ${formatNumber(received, to === 'usdt' ? 2 : 8)} ${to.toUpperCase()}\n` +
          `💰 Fee: ${formatNumber(fee, from === 'usdt' ? 2 : 8)} ${from.toUpperCase()} (0.5%)\n\n` +
          `📊 New ${from.toUpperCase()} Balance: ${formatNumber(users[userId][from], from === 'usdt' ? 2 : 8)}\n` +
          `📊 New ${to.toUpperCase()} Balance: ${formatNumber(users[userId][to], to === 'usdt' ? 2 : 8)}`,
          { 
            chat_id: chatId, 
            message_id: q.message.message_id,
            reply_markup: {
              inline_keyboard: [
                [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
              ]
            }
          }
        );
      } else {
        await bot.answerCallbackQuery(q.id, { text: "❌ Insufficient balance", show_alert: true });
      }
      return;
    }

    if (data.startsWith("withdraw_")) {
      const wallet = data.replace("withdraw_", "");
      withdrawStates[userId] = { step: "amount", wallet };

      return bot.sendMessage(
        chatId,
        `💰 Enter amount of ${wallet.toUpperCase()} to sell:\n\n` +
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
        
        delete withdrawStates[userId];
        
        await bot.answerCallbackQuery(q.id, { text: "✅ Sale successful!", show_alert: true });
        
        return bot.editMessageText(
          `✅ Crypto Sale Successful!\n\n` +
          `💰 Amount: ${formatNumber(amount, wallet === 'naira' ? 2 : 8)} ${wallet.toUpperCase()}\n` +
          `💵 Received: ₦${formatNumber(ngnAmount)}\n` +
          `📊 New ${wallet.toUpperCase()} Balance: ${formatNumber(users[userId][wallet], wallet === 'naira' ? 2 : 8)}\n` +
          `📊 New Naira Balance: ₦${formatNumber(users[userId].naira)}`,
          { 
            chat_id: chatId, 
            message_id: q.message.message_id,
            reply_markup: {
              inline_keyboard: [
                [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
              ]
            }
          }
        );
      } else {
        await bot.answerCallbackQuery(q.id, { text: "❌ Insufficient balance", show_alert: true });
      }
      return;
    }

    if (data === "add_bank_account") {
      if (NIGERIAN_BANKS.length === 0) {
        try {
          NIGERIAN_BANKS = await paymentProcessor.getBanks();
        } catch (error) {
          console.error("Failed to load banks:", error);
        }
      }
      
      bankAccountStates[userId] = { step: "select_bank" };
      
      const bankButtons = NIGERIAN_BANKS.slice(0, 20).map(bank => [{
        text: bank.name,
        callback_data: `bank_selected_${bank.code}`
      }]);
      
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
        `• KYC Verified: ${user.kycVerified ? '✅ Yes' : '❌ No'}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💰 Withdraw Now", callback_data: "withdraw_naira" }],
              [{ text: "❌ Remove", callback_data: "remove_bank_account" }],
              [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
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
      
      return bot.editMessageText(
        "✅ Bank account removed successfully",
        { 
          chat_id: chatId, 
          message_id: q.message.message_id,
          reply_markup: {
            inline_keyboard: [
              [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
            ]
          }
        }
      );
    }

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

    if (data === "withdraw_max") {
      if (!user.bankAccount) {
        await bot.answerCallbackQuery(q.id, { 
          text: "❌ Please add a bank account first", 
          show_alert: true 
        });
        return;
      }
      
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
      
      return bot.editMessageText(
        `✅ Withdrawal Initiated!\n\n` +
        `💰 Amount: ₦${formatNumber(amount)}\n` +
        `💸 Fee: ₦${formatNumber(fee)}\n` +
        `📥 Net Sent: ₦${formatNumber(netAmount)}\n\n` +
        `🏦 Bank: ${user.bankAccount.bankName}\n` +
        `👤 Account: ${user.bankAccount.accountName}\n\n` +
        `📝 Transaction ID: ${withdrawalResult.transferId}\n` +
        `🔢 Reference: ${withdrawalResult.reference}\n\n` +
        `📊 New Balance: ₦${formatNumber(user.naira)}\n` +
        `⏳ Status: Processing\n` +
        `⏰ Funds will arrive within 1-24 hours.`,
        { 
          chat_id: chatId, 
          message_id: q.message.message_id,
          reply_markup: {
            inline_keyboard: [
              [{ text: "📊 Check Status", callback_data: `check_status_${withdrawalResult.transferId}` }],
              [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
            ]
          }
        }
      );
    }

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
// EXPRESS ROUTES
// ===============================

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: `${BUSINESS_NAME} Trade Bot`,
    users: Object.keys(users).length,
    hdWallet: {
      masterAddress: walletSystem.masterNode.address,
      totalUserAddresses: walletSystem.userAddresses.size,
      system: "BIP32/HD Wallet"
    },
    banks: {
      loaded: NIGERIAN_BANKS.length,
    },
    uptime: process.uptime()
  });
});

// Debug endpoint
app.get("/debug", async (req, res) => {
  try {
    const info = webhookUrl ? await bot.getWebHookInfo() : { url: "No webhook" };
    res.json({
      webhook: info,
      hd_wallet: {
        master_address: walletSystem.masterNode.address,
        total_users: walletSystem.userAddresses.size,
      },
      banks: {
        loaded: NIGERIAN_BANKS.length,
      }
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Banks endpoint
app.get("/banks", (req, res) => {
  res.json({
    totalBanks: NIGERIAN_BANKS.length,
    banks: NIGERIAN_BANKS.slice(0, 10),
    loaded: NIGERIAN_BANKS.length > 0,
    timestamp: new Date().toISOString()
  });
});

// Telegram webhook endpoint
app.post("/api/webhook", async (req, res) => {
  console.log("📥 Telegram webhook received");
  
  // Immediately respond to Telegram
  res.sendStatus(200);
  
  // Process asynchronously
  setTimeout(async () => {
    try {
      const update = req.body;
      
      if (update.message) {
        await handleMessage(update.message);
      } else if (update.callback_query) {
        await handleCallbackQuery(update.callback_query);
      }
    } catch (error) {
      console.error("❌ Webhook processing error:", error);
    }
  }, 0);
});

// Crypto deposit webhook endpoint
app.post("/api/crypto-webhook", async (req, res) => {
  try {
    console.log('💰 Crypto webhook received');
    
    const { address, amount, currency, txHash } = req.body;
    
    if (address && amount && currency && txHash) {
      const userInfo = walletSystem.getUserByAddress(address);
      
      if (userInfo) {
        const { userId, cryptoType } = userInfo;
        if (users[userId]) {
          users[userId][cryptoType] = (users[userId][cryptoType] || 0) + parseFloat(amount);
          
          await bot.sendMessage(
            userId,
            `💰 Deposit Confirmed!\n\n` +
            `Amount: ${amount} ${cryptoType.toUpperCase()}\n` +
            `Transaction: ${txHash.slice(0, 20)}...\n` +
            `New Balance: ${users[userId][cryptoType]} ${cryptoType.toUpperCase()}\n\n` +
            `✅ Funds have been added to your account.`,
            { parse_mode: 'Markdown' }
          );
        }
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('💰 Crypto webhook error:', error);
    res.sendStatus(500);
  }
});

// Flutterwave webhook endpoint
app.post("/api/transfer-webhook", async (req, res) => {
  try {
    console.log('💰 Flutterwave webhook received');
    res.sendStatus(200);
  } catch (error) {
    console.error('💰 Flutterwave webhook error:', error);
    res.sendStatus(500);
  }
});

// ===============================
// INITIALIZATION
// ===============================
async function initialize() {
  try {
    // Get bot info
    const me = await bot.getMe();
    console.log(`🤖 Bot connected: @${me.username}`);
    
    // Load banks
    console.log("🏦 Loading Nigerian banks...");
    NIGERIAN_BANKS = await paymentProcessor.getBanks();
    console.log(`✅ Loaded ${NIGERIAN_BANKS.length} banks`);
    
    // Setup webhook if we have a URL
    if (webhookUrl) {
      try {
        await bot.deleteWebHook();
        await new Promise(resolve => setTimeout(resolve, 1000));
        await bot.setWebHook(webhookUrl);
        console.log(`✅ Webhook set to: ${webhookUrl}`);
      } catch (error) {
        console.log("⚠️ Webhook setup failed:", error.message);
      }
    }
    
    console.log(`\n🤖 ${BUSINESS_NAME} Bot Ready!\n`);
    console.log(`📊 Features:`);
    console.log(`  • HD Wallets: ✅`);
    console.log(`  • Bank Support: ✅ (${NIGERIAN_BANKS.length} banks)`);
    console.log(`  • Flutterwave: ${FLW_SECRET_KEY ? '✅ Connected' : '❌ Disabled'}`);
    
  } catch (error) {
    console.error("❌ Initialization error:", error);
  }
}

// Export the Express app for Vercel
module.exports = app;

// Initialize the bot
initialize();