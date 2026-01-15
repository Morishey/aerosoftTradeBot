// ===============================
// AEROSOFT TRADE BOT - REPLIT VERSION
// ===============================

// Imports
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");
const { ethers } = require("ethers");
const bip39 = require("bip39");
const keepAlive = require("./server"); // For Replit uptime

// Environment validation
const TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const FLW_PUBLIC_KEY = process.env.FLW_PUBLIC_KEY;
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Aerosoft Trade";
const WALLET_MNEMONIC = process.env.WALLET_MNEMONIC;
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
  console.error("❌ Missing TELEGRAM_TOKEN. Please add it in Replit Secrets!");
  console.log("Go to: Tools → Secrets → Add TELEGRAM_TOKEN=your_bot_token");
  process.exit(1);
}

// Initialize Express app for Replit web server
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simple CORS for Replit
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

// Initialize Telegram bot with POLLING (Replit supports it)
const bot = new TelegramBot(TOKEN, { 
  polling: {
    interval: 300,
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});

console.log("🤖 Starting Telegram Bot with polling...");

// ===============================
// HD WALLET SYSTEM (UPDATED for ethers v6)
// ===============================
class HDWalletSystem {
  constructor() {
    if (!WALLET_MNEMONIC) {
      console.warn("⚠️ WALLET_MNEMONIC not set. Generating new master wallet...");
      this.mnemonic = bip39.generateMnemonic();
      console.log(`📝 NEW MASTER MNEMONIC (SAVE THIS!): ${this.mnemonic}`);
      console.log("⚠️ Add this to Replit Secrets as WALLET_MNEMONIC");
    } else {
      this.mnemonic = WALLET_MNEMONIC;
      console.log(`✅ Loaded existing master wallet`);
    }
    
    // Create HD wallet from mnemonic
    this.hdNode = ethers.HDNodeWallet.fromPhrase(this.mnemonic);
    this.userAddresses = new Map();
    this.addressToUser = new Map();
    
    console.log(`💰 Master Wallet: ${this.hdNode.address}`);
  }
  
  getUserDepositAddress(userId, cryptoType) {
    if (!this.userAddresses.has(userId)) {
      this.userAddresses.set(userId, {});
    }
    
    const userWallets = this.userAddresses.get(userId);
    
    if (!userWallets[cryptoType]) {
      const path = this.getDerivationPath(userId, cryptoType);
      
      // Derive child wallet
      const derivedWallet = this.hdNode.derivePath(path);
      
      userWallets[cryptoType] = {
        address: derivedWallet.address,
        path: path,
        created: new Date().toISOString()
      };
      
      this.addressToUser.set(derivedWallet.address.toLowerCase(), {
        userId: userId,
        cryptoType: cryptoType
      });
    }
    
    return userWallets[cryptoType].address;
  }
  
  getDerivationPath(userId, cryptoType) {
    const userIdNum = this.hashUserId(userId);
    
    // Standard BIP44 derivation paths
    const paths = {
      'btc': `m/44'/0'/0'/0/${userIdNum}`,
      'eth': `m/44'/60'/0'/0/${userIdNum}`,
      'usdt': `m/44'/60'/0'/0/${userIdNum}`, // USDT on Ethereum
      'sol': `m/44'/501'/0'/${userIdNum}`, // Solana uses different path
    };
    
    return paths[cryptoType] || paths['eth'];
  }
  
  hashUserId(userId) {
    const str = userId.toString();
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
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
        { 
          headers: this.headers, 
          timeout: 10000 
        }
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
        { 
          headers: this.headers, 
          timeout: 15000 
        }
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
        { 
          headers: this.headers, 
          timeout: 10000 
        }
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
        { 
          headers: this.headers, 
          timeout: 10000 
        }
      );
      
      console.log(`✅ Successfully loaded ${response.data.data.length} banks`);
      return response.data.data
        .filter(bank => bank.code && bank.name)
        .map(bank => ({
          name: bank.name,
          code: bank.code,
          id: bank.id
        }))
        .sort((a, b) => a.name.localeCompare(b.name)); // Sort alphabetically
    } catch (error) {
      console.error('❌ Failed to fetch banks:', error.message);
      // Enhanced fallback banks
      return [
        { name: "Access Bank", code: "044", id: "044" },
        { name: "First Bank of Nigeria", code: "011", id: "011" },
        { name: "Guaranty Trust Bank (GTB)", code: "058", id: "058" },
        { name: "United Bank for Africa (UBA)", code: "033", id: "033" },
        { name: "Zenith Bank", code: "057", id: "057" },
        { name: "Stanbic IBTC Bank", code: "221", id: "221" },
        { name: "Fidelity Bank", code: "070", id: "070" },
        { name: "Union Bank", code: "032", id: "032" },
        { name: "Polaris Bank", code: "076", id: "076" },
        { name: "Wema Bank", code: "035", id: "035" }
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
// STATE STORAGE (in-memory for Replit)
// Note: This will reset when Replit restarts. Consider using Replit Database for persistence
// ===============================
const users = new Map(); // Changed to Map for better performance
const withdrawStates = new Map();
const swapStates = new Map();
const referralCodes = new Map();
const bankAccountStates = new Map();
let NIGERIAN_BANKS = [];

// ===============================
// HELPER FUNCTIONS
// ===============================
function initUser(userId, referredBy = null) {
  if (!users.has(userId)) {
    const userData = { 
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
    
    // Generate deposit addresses for all supported cryptos
    ['btc', 'eth', 'sol', 'usdt'].forEach(crypto => {
      userData.depositAddresses[crypto] = walletSystem.getUserDepositAddress(userId, crypto);
    });
    
    users.set(userId, userData);
    
    // Handle referral bonus if applicable
    if (referredBy && users.has(referredBy)) {
      const referrer = users.get(referredBy);
      referrer.referrals.push({
        userId: userId,
        date: new Date().toISOString(),
        bonus: 100
      });
      referrer.referralRewards += 100;
      referrer.naira += 100;
      
      userData.naira += 500; // Bonus for referred user
    }
  }
  return users.get(userId);
}

function generateReferralCode(userId) {
  const code = 'AERO' + Math.random().toString(36).substring(2, 8).toUpperCase();
  referralCodes.set(code, userId);
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
      usd_ngn: { buy: 1440.00, sell: 1500.00 } // Fallback rate
    };
  } catch (error) {
    console.error("Failed to fetch rates, using fallback:", error.message);
    // Fallback rates
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
  if (isNaN(num) || num === null || num === undefined) {
    return "0.00";
  }
  return new Intl.NumberFormat('en-NG', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(num);
}

function validateAccountNumber(accountNumber) {
  return /^\d{10}$/.test(accountNumber);
}

function validateAccountName(accountName) {
  if (!accountName || typeof accountName !== 'string') return false;
  const words = accountName.trim().split(/\s+/);
  return words.length >= 2 && accountName.length >= 5;
}

function calculateSwap(amount, fromRate, toRate) {
  const fee = 0.005; // 0.5%
  const amountAfterFee = amount * (1 - fee);
  const received = (amountAfterFee * fromRate) / toRate;
  return {
    received: received,
    fee: amount * fee,
    feePercent: fee * 100
  };
}

function checkWithdrawalLimit(userId, amount) {
  const user = users.get(userId);
  if (!user) return { allowed: false, reason: "User not found" };
  
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
  
  return { 
    allowed: true, 
    remaining: user.dailyWithdrawalLimit - user.dailyWithdrawn 
  };
}

async function processRealWithdrawal(userId, amount, bankDetails) {
  const user = users.get(userId);
  if (!user) {
    return {
      success: false,
      error: "User not found"
    };
  }
  
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
  
  // Normalize names for comparison
  const normalizeName = (name) => name.toLowerCase().replace(/\s+/g, ' ').trim();
  const providedName = normalizeName(bankDetails.accountName);
  const verifiedName = normalizeName(verification.accountName);
  
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
    // Rollback changes if transfer fails
    user.naira += amount;
    user.totalWithdrawn -= amount;
    user.dailyWithdrawn -= amount;
    
    return {
      success: false,
      error: transferResult.error
    };
  }
  
  // Add transaction record
  user.transactions.push({
    type: 'withdrawal',
    amount: amount,
    reference: reference,
    transferId: transferResult.transferId,
    date: new Date().toISOString(),
    status: 'processing'
  });
  
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
      note: "Send only BTC to this address. Do not send other cryptocurrencies.",
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
      ["🏦 Bank Account", "ℹ️ Help"]
    ],
    resize_keyboard: true,
    persistent: true
  }
};

// ===============================
// MESSAGE HANDLER
// ===============================
async function handleMessage(msg) {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text?.trim();

    if (!text) return;

    console.log(`📨 Message from ${userId}: ${text}`);

    // Handle /start command
    if (text.startsWith('/start')) {
      const parts = text.split(' ');
      const referralCode = parts[1];
      let referredBy = null;
      
      if (referralCode && referralCodes.has(referralCode)) {
        referredBy = referralCodes.get(referralCode);
      }
      
      const user = initUser(userId, referredBy);
      
      let welcomeMsg = `👋 Welcome to *${BUSINESS_NAME} Bot!*\n\n`;
      
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
      welcomeMsg += `⚠️ *Important Information:*\n`;
      welcomeMsg += `• Minimum withdrawal: ₦500\n`;
      welcomeMsg += `• Fee: 1.5% (minimum ₦50)\n`;
      welcomeMsg += `• Daily limit: ₦500,000\n`;
      welcomeMsg += `• Support: @AerosoftSupport`;
      
      await bot.sendMessage(chatId, welcomeMsg, { 
        parse_mode: 'Markdown',
        ...defaultKeyboard 
      });
      return;
    }

    const user = initUser(userId);
    const withdrawState = withdrawStates.get(userId);
    const swapState = swapStates.get(userId);
    const bankState = bankAccountStates.get(userId);

    // Handle swap amount input
    if (swapState && swapState.step === "amount") {
      const { swapType } = swapState;
      const [from, to] = swapType.split("_to_");
      const amount = parseFloat(text);
      
      if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(chatId, "❌ Please enter a valid positive number");
        return;
      }
      
      if (amount > user[from]) {
        await bot.sendMessage(
          chatId,
          `❌ Insufficient balance!\nAvailable: ${formatNumber(user[from], from === 'usdt' ? 2 : 8)} ${from.toUpperCase()}`
        );
        return;
      }

      const rates = await fetchRates();
      const fromRate = from === 'usdt' ? 1 : rates[from].usd;
      const toRate = to === 'usdt' ? 1 : rates[to].usd;
      
      const swapResult = calculateSwap(amount, fromRate, toRate);
      
      swapStates.set(userId, {
        step: "confirm",
        swapType,
        amount,
        received: swapResult.received,
        fee: swapResult.fee
      });

      await bot.sendMessage(
        chatId,
        `🔄 *Confirm Swap*\n\n` +
        `📤 Send: ${formatNumber(amount, from === 'usdt' ? 2 : 8)} ${from.toUpperCase()}\n` +
        `📥 Receive: ${formatNumber(swapResult.received, to === 'usdt' ? 2 : 8)} ${to.toUpperCase()}\n` +
        `💰 Fee: ${formatNumber(swapResult.fee, from === 'usdt' ? 2 : 8)} ${from.toUpperCase()} (${swapResult.feePercent}%)\n\n` +
        `💱 Rate: 1 ${from.toUpperCase()} = ${formatNumber(swapResult.received / amount, 8)} ${to.toUpperCase()}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Confirm Swap", callback_data: "confirm_swap" }],
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
      return;
    }

    // Handle withdrawal amount input
    if (withdrawState && withdrawState.step === "amount" && withdrawState.type !== "bank") {
      const { wallet } = withdrawState;
      const amount = parseFloat(text);
      
      if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(chatId, "❌ Please enter a valid positive number");
        return;
      }
      
      if (amount > user[wallet]) {
        await bot.sendMessage(
          chatId,
          `❌ Insufficient balance!\nAvailable: ${formatNumber(user[wallet], wallet === 'naira' ? 2 : 8)} ${wallet.toUpperCase()}`
        );
        return;
      }

      const rates = await fetchRates();
      const ngnAmount = amount * rates[wallet].ngn;

      withdrawStates.set(userId, {
        step: "confirm",
        wallet,
        amount,
        ngnAmount
      });

      await bot.sendMessage(
        chatId,
        `⚠️ *Confirm Crypto Sale*\n\n` +
        `💰 Amount: ${formatNumber(amount, wallet === 'naira' ? 2 : 8)} ${wallet.toUpperCase()}\n` +
        `💵 You'll receive: ₦${formatNumber(ngnAmount)}\n` +
        `📊 Fee: ₦0\n` +
        `📈 Total: ₦${formatNumber(ngnAmount)}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Confirm Sale", callback_data: "confirm_withdraw" }],
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
      return;
    }

    // Handle bank account number input
    if (bankState && bankState.step === "enter_account_number") {
      const accountNumber = text.trim();
      
      if (!validateAccountNumber(accountNumber)) {
        await bot.sendMessage(
          chatId,
          "❌ Invalid account number. Please enter a valid 10-digit account number (numbers only)."
        );
        return;
      }
      
      bankState.accountNumber = accountNumber;
      bankState.step = "enter_account_name";
      bankAccountStates.set(userId, bankState);
      
      await bot.sendMessage(
        chatId,
        `🏦 Account Number: ${accountNumber}\n\nPlease enter the account name *exactly* as it appears on your bank statement:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
      return;
    }

    // Handle bank account name input
    if (bankState && bankState.step === "enter_account_name") {
      const accountName = text.trim();
      
      if (!validateAccountName(accountName)) {
        await bot.sendMessage(
          chatId,
          "❌ Invalid account name. Please enter your full name (at least 2 words, minimum 5 characters)."
        );
        return;
      }
      
      bankState.accountName = accountName;
      bankAccountStates.set(userId, bankState);
      
      const verifyMsg = await bot.sendMessage(
        chatId,
        "🔍 Verifying your bank account details with Flutterwave...",
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
          bankAccountStates.delete(userId);
          await bot.editMessageText(
            `❌ Account verification failed:\n${verification.error}\n\nPlease try again.`,
            { 
              chat_id: chatId, 
              message_id: verifyMsg.message_id,
              parse_mode: 'Markdown'
            }
          );
          return;
        }
        
        // Normalize names for comparison
        const normalizeName = (name) => name.toLowerCase().replace(/\s+/g, ' ').trim();
        const providedName = normalizeName(bankState.accountName);
        const verifiedName = normalizeName(verification.accountName);
        
        if (providedName !== verifiedName) {
          bankAccountStates.delete(userId);
          await bot.editMessageText(
            `❌ Account name doesn't match.\n\n` +
            `You entered: *${bankState.accountName}*\n` +
            `Bank has: *${verification.accountName}*\n\n` +
            `Please try again with the correct account name.`,
            { 
              chat_id: chatId, 
              message_id: verifyMsg.message_id,
              parse_mode: 'Markdown'
            }
          );
          return;
        }
        
        user.bankAccount = {
          bankCode: bankState.bankCode,
          bankName: bankState.bankName,
          accountNumber: bankState.accountNumber,
          accountName: verification.accountName,
          verified: true,
          addedAt: new Date().toISOString()
        };
        
        bankAccountStates.delete(userId);
        
        await bot.editMessageText(
          `✅ *Bank Account Verified Successfully!*\n\n` +
          `🏦 Bank: ${bankState.bankName}\n` +
          `📞 Account: ${bankState.accountNumber}\n` +
          `👤 Name: ${verification.accountName}\n\n` +
          `You can now withdraw funds to this account.`,
          {
            chat_id: chatId,
            message_id: verifyMsg.message_id,
            parse_mode: 'Markdown',
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
        bankAccountStates.delete(userId);
        await bot.editMessageText(
          "❌ Failed to verify account. Please try again later.",
          { 
            chat_id: chatId, 
            message_id: verifyMsg.message_id 
          }
        );
      }
      return;
    }

    // Handle bank withdrawal amount input
    if (withdrawState && withdrawState.step === "amount" && withdrawState.type === "bank") {
      const amount = parseFloat(text.replace(/[₦,]/g, ''));
      
      if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(chatId, "❌ Please enter a valid amount");
        return;
      }
      
      if (amount > user.naira) {
        await bot.sendMessage(
          chatId,
          `❌ Insufficient balance!\nAvailable: ₦${formatNumber(user.naira)}`
        );
        return;
      }
      
      const feePercentage = 0.015; // 1.5%
      const calculatedFee = amount * feePercentage;
      const fee = Math.max(calculatedFee, 50);
      const netAmount = amount - fee;
      
      if (netAmount < 500) {
        await bot.sendMessage(
          chatId,
          `❌ Minimum withdrawal is ₦500 after fees.\n\n` +
          `Amount: ₦${formatNumber(amount)}\n` +
          `Fee: ₦${formatNumber(fee)}\n` +
          `Net: ₦${formatNumber(netAmount)}\n\n` +
          `Please enter at least ₦550.`
        );
        return;
      }
      
      const limitCheck = checkWithdrawalLimit(userId, amount);
      if (!limitCheck.allowed) {
        await bot.sendMessage(
          chatId,
          `❌ ${limitCheck.reason}\n\n` +
          `Daily Limit: ₦${formatNumber(user.dailyWithdrawalLimit)}\n` +
          `Used Today: ₦${formatNumber(user.dailyWithdrawn)}\n` +
          `Remaining: ₦${formatNumber(limitCheck.remaining)}`
        );
        return;
      }
      
      withdrawStates.set(userId, {
        step: "confirm",
        wallet: 'naira',
        type: "bank",
        amount,
        fee,
        netAmount
      });

      await bot.sendMessage(
        chatId,
        `⚠️ *Confirm Bank Withdrawal*\n\n` +
        `🏦 Bank: ${user.bankAccount.bankName}\n` +
        `👤 Account: ${user.bankAccount.accountName}\n\n` +
        `💰 Amount: ₦${formatNumber(amount)}\n` +
        `💸 Fee (1.5%): ₦${formatNumber(fee)}\n` +
        `📥 You Receive: ₦${formatNumber(netAmount)}\n\n` +
        `📊 Current Balance: ₦${formatNumber(user.naira)}\n` +
        `📊 New Balance: ₦${formatNumber(user.naira - amount)}\n\n` +
        `Do you want to proceed?`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Confirm Withdrawal", callback_data: "confirm_bank_withdraw" }],
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
      return;
    }

    // Handle menu commands
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
          ? `✅ Bank: ${user.bankAccount.bankName}\nAccount: ****${user.bankAccount.accountNumber.slice(-4)}`
          : '❌ No bank account added';
        
        await bot.sendMessage(
          chatId,
          `🏦 *Bank Account Management*\n\n` +
          `Status: ${bankStatus}\n\n` +
          `📊 Available Banks: ${NIGERIAN_BANKS.length} banks loaded\n\n` +
          `Select an option:`,
          {
            parse_mode: 'Markdown',
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
        break;

      case "💰 Naira Wallet":
        const limitCheck = checkWithdrawalLimit(userId, 0);
        const nairaMsg = `💰 *Naira Wallet*\n\n` +
          `Balance: ₦${formatNumber(user.naira)}\n` +
          `Bank Account: ${user.bankAccount ? '✅ Verified' : '❌ Not Added'}\n\n` +
          `📊 *Withdrawal Limits:*\n` +
          `• Daily Limit: ₦${formatNumber(user.dailyWithdrawalLimit)}\n` +
          `• Used Today: ₦${formatNumber(user.dailyWithdrawn)}\n` +
          `• Remaining: ₦${formatNumber(limitCheck.remaining)}\n\n`;
        
        if (user.bankAccount) {
          await bot.sendMessage(
            chatId,
            nairaMsg + `What would you like to do?`,
            {
              parse_mode: 'Markdown',
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
          await bot.sendMessage(
            chatId,
            nairaMsg + `To withdraw funds, add a bank account first.`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: "➕ Add Bank Account", callback_data: "add_bank_account" }],
                  [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
                ]
              }
            }
          );
        }
        break;

      case "₿ BTC Wallet":
        try {
          const btcRates = await fetchRates();
          const btcAddress = walletSystem.getUserDepositAddress(userId, 'btc');
          
          await bot.sendMessage(
            chatId,
            `₿ *BTC Wallet*\n\n` +
            `Balance: ${formatNumber(user.btc, 8)} BTC\n` +
            `Value: ₦${formatNumber(user.btc * btcRates.btc.ngn)}\n` +
            `Rate: ₦${formatNumber(btcRates.btc.ngn)} per BTC\n\n` +
            `📥 *Deposit Address:*\n\`${btcAddress}\``,
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
        } catch (error) {
          console.error("BTC wallet error:", error);
          await bot.sendMessage(chatId, "❌ Error loading BTC wallet. Please try again.");
        }
        break;

      case "💵 ETH Wallet":
        try {
          const ethRates = await fetchRates();
          const ethAddress = walletSystem.getUserDepositAddress(userId, 'eth');
          
          await bot.sendMessage(
            chatId,
            `💵 *ETH Wallet*\n\n` +
            `Balance: ${formatNumber(user.eth, 8)} ETH\n` +
            `Value: ₦${formatNumber(user.eth * ethRates.eth.ngn)}\n` +
            `Rate: ₦${formatNumber(ethRates.eth.ngn)} per ETH\n\n` +
            `📥 *Deposit Address:*\n\`${ethAddress}\``,
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
        } catch (error) {
          console.error("ETH wallet error:", error);
          await bot.sendMessage(chatId, "❌ Error loading ETH wallet. Please try again.");
        }
        break;

      case "🟣 SOL Wallet":
        try {
          const solRates = await fetchRates();
          const solAddress = walletSystem.getUserDepositAddress(userId, 'sol');
          
          await bot.sendMessage(
            chatId,
            `🟣 *SOL Wallet*\n\n` +
            `Balance: ${formatNumber(user.sol, 8)} SOL\n` +
            `Value: ₦${formatNumber(user.sol * solRates.sol.ngn)}\n` +
            `Rate: ₦${formatNumber(solRates.sol.ngn)} per SOL\n\n` +
            `📥 *Deposit Address:*\n\`${solAddress}\``,
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
        } catch (error) {
          console.error("SOL wallet error:", error);
          await bot.sendMessage(chatId, "❌ Error loading SOL wallet. Please try again.");
        }
        break;

      case "🌐 USDT Wallet":
        try {
          const usdtRates = await fetchRates();
          const usdtAddress = walletSystem.getUserDepositAddress(userId, 'usdt');
          
          await bot.sendMessage(
            chatId,
            `🌐 *USDT Wallet*\n\n` +
            `Balance: ${formatNumber(user.usdt, 2)} USDT\n` +
            `Value: ₦${formatNumber(user.usdt * usdtRates.usdt.ngn)}\n` +
            `Rate: ₦${formatNumber(usdtRates.usdt.ngn)} per USDT\n\n` +
            `📥 *Deposit Address:*\n\`${usdtAddress}\``,
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
        } catch (error) {
          console.error("USDT wallet error:", error);
          await bot.sendMessage(chatId, "❌ Error loading USDT wallet. Please try again.");
        }
        break;

      case "🔄 Swap Crypto":
        await bot.sendMessage(
          chatId,
          `🔄 *Crypto Swap*\n\n` +
          `Trade between cryptocurrencies instantly!\n` +
          `Fee: 0.5% per transaction\n\n` +
          `Select a swap pair:`,
          {
            parse_mode: 'Markdown',
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
        break;

      case "BTC → USDT":
        swapStates.set(userId, { step: "amount", swapType: "btc_to_usdt" });
        await bot.sendMessage(
          chatId,
          `🔄 *BTC to USDT Swap*\n\n` +
          `Available: ${formatNumber(user.btc, 8)} BTC\n\n` +
          `Enter amount of BTC to swap:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: "Use All", callback_data: "use_all_btc" }],
                [{ text: "❌ Cancel", callback_data: "cancel_action" }]
              ]
            }
          }
        );
        break;

      case "ETH → USDT":
        swapStates.set(userId, { step: "amount", swapType: "eth_to_usdt" });
        await bot.sendMessage(
          chatId,
          `🔄 *ETH to USDT Swap*\n\n` +
          `Available: ${formatNumber(user.eth, 8)} ETH\n` +
          `Enter amount of ETH to swap:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: "Use All", callback_data: "use_all_eth" }],
                [{ text: "❌ Cancel", callback_data: "cancel_action" }]
              ]
            }
          }
        );
        break;

      case "SOL → USDT":
        swapStates.set(userId, { step: "amount", swapType: "sol_to_usdt" });
        await bot.sendMessage(
          chatId,
          `🔄 *SOL to USDT Swap*\n\n` +
          `Available: ${formatNumber(user.sol, 8)} SOL\n` +
          `Enter amount of SOL to swap:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: "Use All", callback_data: "use_all_sol" }],
                [{ text: "❌ Cancel", callback_data: "cancel_action" }]
              ]
            }
          }
        );
        break;

      case "USDT → BTC":
        swapStates.set(userId, { step: "amount", swapType: "usdt_to_btc" });
        await bot.sendMessage(
          chatId,
          `🔄 *USDT to BTC Swap*\n\n` +
          `Available: ${formatNumber(user.usdt, 2)} USDT\n` +
          `Enter amount of USDT to swap:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: "Use All", callback_data: "use_all_usdt" }],
                [{ text: "❌ Cancel", callback_data: "cancel_action" }]
              ]
            }
          }
        );
        break;

      case "USDT → ETH":
        swapStates.set(userId, { step: "amount", swapType: "usdt_to_eth" });
        await bot.sendMessage(
          chatId,
          `🔄 *USDT to ETH Swap*\n\n` +
          `Available: ${formatNumber(user.usdt, 2)} USDT\n` +
          `Enter amount of USDT to swap:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: "Use All", callback_data: "use_all_usdt" }],
                [{ text: "❌ Cancel", callback_data: "cancel_action" }]
              ]
            }
          }
        );
        break;

      case "USDT → SOL":
        swapStates.set(userId, { step: "amount", swapType: "usdt_to_sol" });
        await bot.sendMessage(
          chatId,
          `🔄 *USDT to SOL Swap*\n\n` +
          `Available: ${formatNumber(user.usdt, 2)} USDT\n` +
          `Enter amount of USDT to swap:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: "Use All", callback_data: "use_all_usdt" }],
                [{ text: "❌ Cancel", callback_data: "cancel_action" }]
              ]
            }
          }
        );
        break;

      case "🎁 Refer and Earn":
        await bot.sendMessage(
          chatId,
          `🎁 *Refer and Earn*\n\n` +
          `💰 Your Referral Code: *${user.referralCode}*\n` +
          `👥 Total Referrals: ${user.referrals.length}\n` +
          `🎯 Total Earnings: ₦${formatNumber(user.referralRewards)}\n\n` +
          `✨ *Referral Rewards:*\n` +
          `• You earn ₦100 per referral\n` +
          `• Your friend gets ₦500 bonus\n\n` +
          `What would you like to do?`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: "📤 Share Referral Link", callback_data: "share_referral" }],
                [{ text: "👥 My Referrals", callback_data: "my_referrals" }],
                [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
              ]
            }
          }
        );
        break;

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
          
          await bot.sendMessage(chatId, rateMessage, { 
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
          await bot.sendMessage(chatId, "❌ Unable to fetch rates. Please try again.");
        }
        break;

      case "ℹ️ Help":
        await bot.sendMessage(
          chatId,
          `ℹ️ *How to Use ${BUSINESS_NAME} Bot*\n\n` +
          `1. *Check Balances*: Tap any wallet button\n` +
          `2. *Deposit Crypto*: Each user gets unique crypto addresses\n` +
          `3. *Withdraw Naira*: Add bank account, then withdraw\n` +
          `4. *Swap Crypto*: Use "🔄 Swap Crypto" menu\n` +
          `5. *Refer & Earn*: Share your referral link\n` +
          `6. *View Rates*: Get live exchange rates\n\n` +
          `💰 *HD Wallet System:*\n` +
          `• Each user gets unique deposit addresses\n` +
          `• All funds go to secure master wallet\n` +
          `• Perfect tracking of all transactions\n\n` +
          `⚠️ *Important Notes:*\n` +
          `• Bank accounts verified with Flutterwave\n` +
          `• Withdrawals processed via Flutterwave\n` +
          `• Minimum withdrawal: ₦500\n` +
          `• Fee: 1.5% (minimum ₦50)\n\n` +
          `📞 Support: @AerosoftSupport\n` +
          `🕒 24/7 Support Available`,
          { parse_mode: 'Markdown' }
        );
        break;

      case "⬅️ Back to Main Menu":
        swapStates.delete(userId);
        withdrawStates.delete(userId);
        bankAccountStates.delete(userId);
        await bot.sendMessage(chatId, "🏠 Main Menu", defaultKeyboard);
        break;

      default:
        // Handle deposit commands from text
        if (text.startsWith("📥 Deposit")) {
          const cryptoMatch = text.match(/📥 Deposit (\w+)/);
          if (cryptoMatch) {
            const cryptoType = cryptoMatch[1].toLowerCase();
            // Simulate callback query
            await handleCallbackQuery({
              from: { id: userId },
              message: { chat: { id: chatId } },
              data: `deposit_${cryptoType}`,
              id: `manual_${Date.now()}`
            });
            return;
          }
        }
        
        await bot.sendMessage(chatId, "❌ Please use the menu buttons below", defaultKeyboard);
    }
  } catch (error) {
    console.error("Message handling error:", error);
    try {
      await bot.sendMessage(chatId, "❌ An error occurred. Please try again.", defaultKeyboard);
    } catch (sendError) {
      console.error("Failed to send error message:", sendError);
    }
  }
}

// ===============================
// CALLBACK QUERY HANDLER
// ===============================
async function handleCallbackQuery(q) {
  const userId = q.from.id;
  const chatId = q.message.chat.id;
  const data = q.data;
  const messageId = q.message.message_id;

  console.log(`🔘 Callback from ${userId}: ${data}`);

  try {
    await bot.answerCallbackQuery(q.id);

    const user = users.get(userId);
    if (!user) {
      await bot.answerCallbackQuery(q.id, { text: "Session expired. Please restart with /start", show_alert: true });
      return;
    }

    // Handle common actions
    if (data === "back_to_menu" || data === "cancel_action") {
      withdrawStates.delete(userId);
      swapStates.delete(userId);
      bankAccountStates.delete(userId);
      await bot.deleteMessage(chatId, messageId).catch(() => {});
      await bot.sendMessage(chatId, "🏠 Main Menu", defaultKeyboard);
      return;
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
      
      await bot.editMessageText(rateMessage, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Refresh Rates", callback_data: "refresh_rates" }],
            [{ text: "⬅️ Back to Menu", callback_data: "back_to_menu" }]
          ]
        }
      });
      return;
    }

    // Handle deposit actions
    if (data.startsWith("deposit_")) {
      const cryptoType = data.replace("deposit_", "");
      
      if (cryptoType === "naira") {
        const depositMsg = `📥 *Deposit Naira*\n\n` +
          `To deposit Naira, please send to:\n` +
          `🏦 Bank: ${BUSINESS_NAME} Bank\n` +
          `📞 Account: 0123456789\n` +
          `👤 Name: ${BUSINESS_NAME} Trade\n\n` +
          `After payment, send proof to @AerosoftSupport`;
        
        await bot.sendMessage(chatId, depositMsg, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
            ]
          }
        });
        return;
      } else {
        const userAddress = walletSystem.getUserDepositAddress(userId, cryptoType);
        const instructions = getDepositInstructions(cryptoType, userAddress);
        
        let depositMsg = `📥 *Deposit ${cryptoType.toUpperCase()}*\n\n`;
        depositMsg += `Your unique deposit address:\n`;
        depositMsg += `\`${userAddress}\`\n\n`;
        depositMsg += `🌐 Network: ${instructions.network}\n`;
        depositMsg += `📦 Minimum: ${instructions.min}\n`;
        depositMsg += `⏱️ Confirmations: ${instructions.confirms}\n`;
        depositMsg += `⚠️ ${instructions.note}\n\n`;
        depositMsg += `💰 Your balance will update automatically after confirmation.`;
        
        await bot.sendMessage(chatId, depositMsg, {
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
        return;
      }
    }

    // Handle copy address
    if (data.startsWith("copy_address_")) {
      const cryptoType = data.replace("copy_address_", "");
      await bot.answerCallbackQuery(q.id, { 
        text: `📋 ${cryptoType.toUpperCase()} address copied to clipboard!`, 
        show_alert: true 
      });
      return;
    }

    // Handle balance check
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

    // Handle "use all" for swaps
    if (data.startsWith("use_all_")) {
      const cryptoType = data.replace("use_all_", "");
      if (user[cryptoType] > 0) {
        await bot.sendMessage(chatId, `${user[cryptoType]}`, { parse_mode: 'Markdown' });
      }
      return;
    }

    // Handle referral sharing
    if (data === "share_referral") {
      const botUsername = (await bot.getMe()).username;
      const referralLink = `https://t.me/${botUsername}?start=${user.referralCode}`;
      const shareText = `Join ${BUSINESS_NAME} Bot and get ₦500 bonus! Use my referral code: ${user.referralCode}`;
      
      await bot.sendMessage(
        chatId,
        `🎁 *Share Your Referral Link*\n\n` +
        `🔗 ${referralLink}\n\n` +
        `💰 You earn ₦100 for each friend who joins!\n` +
        `🎯 Your friends get ₦500 bonus.\n\n` +
        `📤 Share this link with your friends!`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "📤 Share Now", url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(shareText)}` }],
              [{ text: "⬅️ Back", callback_data: "back_to_referral" }]
            ]
          }
        }
      );
      return;
    }

    // Handle my referrals
    if (data === "my_referrals") {
      let referralsText = "👥 *My Referrals*\n\n";
      
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
      
      await bot.sendMessage(chatId, referralsText, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬅️ Back", callback_data: "back_to_referral" }]
          ]
        }
      });
      return;
    }

    if (data === "back_to_referral") {
      await bot.sendMessage(
        chatId,
        `🎁 *Refer and Earn*\n\n` +
        `💰 Your Referral Code: *${user.referralCode}*\n` +
        `👥 Total Referrals: ${user.referrals.length}\n` +
        `🎯 Total Earnings: ₦${formatNumber(user.referralRewards)}\n\n` +
        `✨ *Referral Rewards:*\n` +
        `• You earn ₦100 per referral\n` +
        `• Your friend gets ₦500 bonus\n\n` +
        `What would you like to do?`,
        {
          parse_mode: 'Markdown',
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
      return;
    }

    if (data === "claim_rewards") {
      await bot.answerCallbackQuery(q.id, { 
        text: "✅ All rewards are automatically added to your Naira wallet!", 
        show_alert: true 
      });
      return;
    }

    // Handle swap confirmation
    if (data === "confirm_swap") {
      const state = swapStates.get(userId);
      if (!state || state.step !== "confirm") {
        await bot.answerCallbackQuery(q.id, { text: "Session expired. Please start over.", show_alert: true });
        return;
      }

      const { swapType, amount, received, fee } = state;
      const [from, to] = swapType.split("_to_");
      
      if (user[from] >= amount) {
        user[from] -= amount;
        user[to] += received;
        
        // Record transaction
        user.transactions.push({
          type: 'swap',
          from: from,
          to: to,
          amount: amount,
          received: received,
          fee: fee,
          date: new Date().toISOString()
        });
        
        swapStates.delete(userId);
        
        await bot.answerCallbackQuery(q.id, { text: "✅ Swap successful!", show_alert: true });
        
        await bot.editMessageText(
          `✅ *Swap Completed!*\n\n` +
          `📤 Sent: ${formatNumber(amount, from === 'usdt' ? 2 : 8)} ${from.toUpperCase()}\n` +
          `📥 Received: ${formatNumber(received, to === 'usdt' ? 2 : 8)} ${to.toUpperCase()}\n` +
          `💰 Fee: ${formatNumber(fee, from === 'usdt' ? 2 : 8)} ${from.toUpperCase()} (0.5%)\n\n` +
          `📊 New ${from.toUpperCase()} Balance: ${formatNumber(user[from], from === 'usdt' ? 2 : 8)}\n` +
          `📊 New ${to.toUpperCase()} Balance: ${formatNumber(user[to], to === 'usdt' ? 2 : 8)}`,
          { 
            chat_id: chatId, 
            message_id: messageId,
            parse_mode: 'Markdown',
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

    // Handle withdrawal actions
    if (data.startsWith("withdraw_")) {
      const wallet = data.replace("withdraw_", "");
      
      if (wallet === "naira" && !user.bankAccount) {
        await bot.answerCallbackQuery(q.id, { 
          text: "❌ Please add a bank account first", 
          show_alert: true 
        });
        return;
      }
      
      withdrawStates.set(userId, { 
        step: "amount", 
        wallet,
        type: wallet === "naira" ? "bank" : "crypto"
      });

      await bot.sendMessage(
        chatId,
        wallet === "naira" 
          ? `💰 Enter amount to withdraw (in Naira):\n\nAvailable: ₦${formatNumber(user.naira)}`
          : `💰 Enter amount of ${wallet.toUpperCase()} to sell:\n\nAvailable: ${formatNumber(user[wallet], wallet === 'usdt' ? 2 : 8)}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
      return;
    }

    // Handle crypto sale confirmation
    if (data === "confirm_withdraw") {
      const state = withdrawStates.get(userId);
      if (!state || state.step !== "confirm") {
        await bot.answerCallbackQuery(q.id, { text: "Session expired", show_alert: true });
        return;
      }

      const { wallet, amount, ngnAmount } = state;
      
      if (user[wallet] >= amount) {
        user[wallet] -= amount;
        user.naira += ngnAmount;
        
        // Record transaction
        user.transactions.push({
          type: 'crypto_sale',
          crypto: wallet,
          amount: amount,
          ngnAmount: ngnAmount,
          date: new Date().toISOString()
        });
        
        withdrawStates.delete(userId);
        
        await bot.answerCallbackQuery(q.id, { text: "✅ Sale successful!", show_alert: true });
        
        await bot.editMessageText(
          `✅ *Crypto Sale Successful!*\n\n` +
          `💰 Amount: ${formatNumber(amount, wallet === 'naira' ? 2 : 8)} ${wallet.toUpperCase()}\n` +
          `💵 Received: ₦${formatNumber(ngnAmount)}\n` +
          `📊 New ${wallet.toUpperCase()} Balance: ${formatNumber(user[wallet], wallet === 'naira' ? 2 : 8)}\n` +
          `📊 New Naira Balance: ₦${formatNumber(user.naira)}`,
          { 
            chat_id: chatId, 
            message_id: messageId,
            parse_mode: 'Markdown',
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

    // Handle bank account management
    if (data === "add_bank_account") {
      if (NIGERIAN_BANKS.length === 0) {
        try {
          NIGERIAN_BANKS = await paymentProcessor.getBanks();
        } catch (error) {
          console.error("Failed to load banks:", error);
        }
      }
      
      bankAccountStates.set(userId, { step: "select_bank" });
      
      // Create paginated bank list (20 per page)
      const bankButtons = NIGERIAN_BANKS.slice(0, 20).map(bank => [{
        text: bank.name,
        callback_data: `bank_selected_${bank.code}`
      }]);
      
      bankButtons.push([{ text: "❌ Cancel", callback_data: "cancel_action" }]);
      
      await bot.sendMessage(
        chatId,
        "🏦 Select your bank from the list below:",
        {
          reply_markup: {
            inline_keyboard: bankButtons
          }
        }
      );
      return;
    }

    if (data.startsWith("bank_selected_")) {
      const bankCode = data.replace("bank_selected_", "");
      const bank = NIGERIAN_BANKS.find(b => b.code === bankCode);
      
      if (!bank) {
        await bot.answerCallbackQuery(q.id, { text: "Bank not found. Please try again.", show_alert: true });
        return;
      }
      
      bankAccountStates.set(userId, {
        step: "enter_account_number",
        bankCode: bankCode,
        bankName: bank.name
      });
      
      await bot.sendMessage(
        chatId,
        `🏦 Bank: *${bank.name}*\n\nPlease enter your 10-digit account number:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
      return;
    }

    if (data === "view_bank_details") {
      if (!user.bankAccount) {
        await bot.sendMessage(
          chatId,
          "❌ No bank account added yet.\n\nClick '➕ Add Bank Account' to add your bank details.",
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: "➕ Add Bank Account", callback_data: "add_bank_account" }],
                [{ text: "⬅️ Back to Main Menu", callback_data: "back_to_menu" }]
              ]
            }
          }
        );
        return;
      }
      
      const bankDetails = user.bankAccount;
      const limitCheck = checkWithdrawalLimit(userId, 0);
      
      await bot.sendMessage(
        chatId,
        `🏦 *Your Bank Details:*\n\n` +
        `Bank: ${bankDetails.bankName}\n` +
        `Account Number: ${bankDetails.accountNumber}\n` +
        `Account Name: ${bankDetails.accountName}\n` +
        `Added: ${new Date(bankDetails.addedAt).toLocaleDateString()}\n\n` +
        `📊 *Withdrawal Limits:*\n` +
        `• Daily Limit: ₦${formatNumber(user.dailyWithdrawalLimit)}\n` +
        `• Used Today: ₦${formatNumber(user.dailyWithdrawn)}\n` +
        `• Remaining: ₦${formatNumber(limitCheck.remaining)}\n` +
        `• KYC Verified: ${user.kycVerified ? '✅ Yes' : '❌ No'}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "💰 Withdraw Now", callback_data: "withdraw_naira" }],
              [{ text: "❌ Remove Account", callback_data: "remove_bank_account" }],
              [{ text: "⬅️ Back", callback_data: "back_to_menu" }]
            ]
          }
        }
      );
      return;
    }

    if (data === "remove_bank_account") {
      if (!user.bankAccount) {
        await bot.answerCallbackQuery(q.id, { 
          text: "No bank account to remove", 
          show_alert: true 
        });
        return;
      }
      
      await bot.sendMessage(
        chatId,
        `⚠️ *Confirm Bank Account Removal*\n\n` +
        `Bank: ${user.bankAccount.bankName}\n` +
        `Account: ${user.bankAccount.accountNumber}\n\n` +
        `Are you sure you want to remove this bank account?`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Yes, Remove", callback_data: "confirm_remove_bank" }],
              [{ text: "❌ Cancel", callback_data: "cancel_action" }]
            ]
          }
        }
      );
      return;
    }

    if (data === "confirm_remove_bank") {
      user.bankAccount = null;
      
      await bot.answerCallbackQuery(q.id, { 
        text: "✅ Bank account removed successfully", 
        show_alert: true 
      });
      
      await bot.editMessageText(
        "✅ Bank account removed successfully",
        { 
          chat_id: chatId, 
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
            ]
          }
        }
      );
      return;
    }

    // Handle bank withdrawal confirmation
    if (data === "confirm_bank_withdraw") {
      const state = withdrawStates.get(userId);
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
        amount,
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

      withdrawStates.delete(userId);
      
      await bot.answerCallbackQuery(q.id, { text: "✅ Withdrawal initiated successfully!", show_alert: true });
      
      await bot.editMessageText(
        `✅ *Withdrawal Initiated!*\n\n` +
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
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "📊 Check Status", callback_data: `check_status_${withdrawalResult.transferId}` }],
              [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
            ]
          }
        }
      );
      return;
    }

    // Handle status check
    if (data.startsWith("check_status_")) {
      const transferId = data.replace("check_status_", "");
      
      const status = await paymentProcessor.checkTransferStatus(transferId);
      
      if (!status) {
        await bot.sendMessage(
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
        return;
      }
      
      const statusData = status.data;
      let statusMsg = `📊 *Transfer Status*\n\n`;
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
      
      await bot.sendMessage(
        chatId,
        statusMsg,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Refresh", callback_data: `check_status_${transferId}` }],
              [{ text: "🏠 Main Menu", callback_data: "back_to_menu" }]
            ]
          }
        }
      );
      return;
    }

  } catch (error) {
    console.error("Callback error:", error);
    await bot.answerCallbackQuery(q.id, { 
      text: "❌ An error occurred. Please try again.", 
      show_alert: true 
    });
  }
}

// ===============================
// SETUP TELEGRAM BOT HANDLERS
// ===============================

// Handle incoming messages
bot.on('message', async (msg) => {
  try {
    await handleMessage(msg);
  } catch (error) {
    console.error("Error in message handler:", error);
  }
});

// Handle callback queries
bot.on('callback_query', async (query) => {
  try {
    await handleCallbackQuery(query);
  } catch (error) {
    console.error("Error in callback handler:", error);
  }
});

// Handle errors
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

bot.on('webhook_error', (error) => {
  console.error('Webhook error:', error);
});

// ===============================
// EXPRESS ROUTES FOR REPLIT
// ===============================

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: `${BUSINESS_NAME} Trade Bot`,
    users: users.size,
    hdWallet: {
      masterAddress: walletSystem.hdNode.address,
      totalUserAddresses: walletSystem.userAddresses.size,
      system: "BIP32/HD Wallet (ethers v6)"
    },
    banks: {
      loaded: NIGERIAN_BANKS.length,
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Debug endpoint
app.get("/debug", (req, res) => {
  res.json({
    bot: {
      username: bot.options.username,
      id: bot.options.id
    },
    hd_wallet: {
      master_address: walletSystem.hdNode.address,
      total_users: walletSystem.userAddresses.size,
      system: "BIP32 HD Wallet"
    },
    state: {
      users: users.size,
      banks_loaded: NIGERIAN_BANKS.length,
      referral_codes: referralCodes.size
    },
    environment: {
      business_name: BUSINESS_NAME,
      has_flutterwave: !!(FLW_SECRET_KEY && FLW_PUBLIC_KEY)
    }
  });
});

// Banks endpoint
app.get("/banks", (req, res) => {
  res.json({
    totalBanks: NIGERIAN_BANKS.length,
    banks: NIGERIAN_BANKS.slice(0, 50),
    loaded: NIGERIAN_BANKS.length > 0,
    timestamp: new Date().toISOString()
  });
});

// User stats endpoint (protected)
app.get("/stats", (req, res) => {
  const apiKey = req.query.key;
  if (apiKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  
  const userStats = Array.from(users.entries()).map(([id, user]) => ({
    id,
    naira: user.naira,
    btc: user.btc,
    eth: user.eth,
    sol: user.sol,
    usdt: user.usdt,
    referrals: user.referrals.length,
    bankAccount: !!user.bankAccount,
    createdAt: user.createdAt
  }));
  
  res.json({
    totalUsers: users.size,
    totalNaira: Array.from(users.values()).reduce((sum, user) => sum + user.naira, 0),
    totalBTC: Array.from(users.values()).reduce((sum, user) => sum + user.btc, 0),
    totalETH: Array.from(users.values()).reduce((sum, user) => sum + user.eth, 0),
    users: userStats
  });
});

// Crypto webhook endpoint
app.post("/crypto-webhook", async (req, res) => {
  try {
    console.log('💰 Crypto webhook received:', req.body);
    
    const { address, amount, currency, txHash, network } = req.body;
    
    if (address && amount && currency && txHash) {
      const userInfo = walletSystem.getUserByAddress(address);
      
      if (userInfo) {
        const { userId, cryptoType } = userInfo;
        const user = users.get(userId);
        
        if (user) {
          const cryptoAmount = parseFloat(amount);
          user[cryptoType] = (user[cryptoType] || 0) + cryptoAmount;
          user.totalDeposited += cryptoAmount;
          
          // Record transaction
          user.transactions.push({
            type: 'deposit',
            crypto: cryptoType,
            amount: cryptoAmount,
            address: address,
            txHash: txHash,
            date: new Date().toISOString(),
            network: network || cryptoType
          });
          
          await bot.sendMessage(
            userId,
            `💰 *Deposit Confirmed!*\n\n` +
            `Amount: ${amount} ${cryptoType.toUpperCase()}\n` +
            `Transaction: \`${txHash.slice(0, 20)}...\`\n` +
            `New Balance: ${user[cryptoType]} ${cryptoType.toUpperCase()}\n\n` +
            `✅ Funds have been added to your account.`,
            { parse_mode: 'Markdown' }
          );
          
          console.log(`✅ Deposit processed for user ${userId}: ${amount} ${cryptoType}`);
        }
      }
    }
    
    res.json({ status: 'received' });
  } catch (error) {
    console.error('💰 Crypto webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===============================
// INITIALIZATION
// ===============================
async function initialize() {
  try {
    // Get bot info
    const me = await bot.getMe();
    console.log(`\n🤖 ====================================`);
    console.log(`🤖 Bot Name: ${me.first_name}`);
    console.log(`🤖 Username: @${me.username}`);
    console.log(`🤖 ID: ${me.id}`);
    console.log(`🤖 ====================================\n`);
    
    // Load banks
    console.log("🏦 Loading Nigerian banks...");
    NIGERIAN_BANKS = await paymentProcessor.getBanks();
    console.log(`✅ Loaded ${NIGERIAN_BANKS.length} banks\n`);
    
    // Start Express server
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🌐 Express server running on port ${PORT}`);
      console.log(`🌐 Health check: http://localhost:${PORT}`);
      console.log(`🌐 Debug info: http://localhost:${PORT}/debug`);
      console.log(`🌐 Banks list: http://localhost:${PORT}/banks\n`);
    });
    
    console.log(`📊 Features Status:`);
    console.log(`  • HD Wallets: ✅ (ethers v6)`);
    console.log(`  • Bank Support: ✅ (${NIGERIAN_BANKS.length} banks)`);
    console.log(`  • Flutterwave: ${FLW_SECRET_KEY ? '✅ Connected' : '❌ Disabled'}`);
    console.log(`  • Crypto Swaps: ✅ (6 pairs)`);
    console.log(`  • Referral System: ✅`);
    console.log(`  • Express Server: ✅ (Port ${PORT})`);
    console.log(`\n🚀 ${BUSINESS_NAME} Bot is ready and running!\n`);
    
    // Log startup info
    console.log(`📝 Startup Information:`);
    console.log(`  • Master Wallet: ${walletSystem.hdNode.address}`);
    console.log(`  • Business Name: ${BUSINESS_NAME}`);
    console.log(`  • Replit Uptime: Enabled`);
    console.log(`  • Memory Storage: ${users.size} users loaded`);
    console.log(`\n💡 Tip: Use /start in Telegram to begin!\n`);
    
  } catch (error) {
    console.error("❌ Initialization error:", error);
    process.exit(1);
  }
}

// ===============================
// START THE APPLICATION
// ===============================
initialize();

// Export for Replit
module.exports = app;