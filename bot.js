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
const WEBHOOK_URL = process.env.REPLIT_URL || process.env.WEBHOOK_URL;

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
  webhookUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co/webhook`;
}

// ===============================
// STATE STORAGE
// ===============================
const users = {};
const withdrawStates = {};
const swapStates = {};
const referralCodes = {};
const bankAccountStates = {};

// Nigerian banks list
const NIGERIAN_BANKS = [
  "Access Bank", "First Bank", "Guaranty Trust Bank (GTB)", "United Bank for Africa (UBA)",
  "Zenith Bank", "Fidelity Bank", "Ecobank Nigeria", "Union Bank", "Stanbic IBTC Bank",
  "Sterling Bank", "Wema Bank", "Polaris Bank", "Unity Bank", "Jaiz Bank", "Keystone Bank",
  "Providus Bank", "SunTrust Bank", "Heritage Bank", "Titan Trust Bank", "Globus Bank"
];

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
      transactions: []
    };
    
    // Add referral bonus to referrer if applicable
    if (referredBy && users[referredBy]) {
      users[referredBy].referrals.push({
        userId: userId,
        date: new Date().toISOString(),
        bonus: 100 // Naira bonus
      });
      users[referredBy].referralRewards += 100;
      users[referredBy].naira += 100;
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
      usdt: { ngn: data.tether.ngn, usd: data.tether.usd }
    };
  } catch (error) {
    console.error("Failed to fetch rates:", error.message);
    return {
      btc: { ngn: 50000000, usd: 35000 },
      eth: { ngn: 3000000, usd: 2000 },
      sol: { ngn: 100000, usd: 70 },
      usdt: { ngn: 1500, usd: 1 }
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
    completedAt: null
  };
  
  if (!users[userId].transactions) {
    users[userId].transactions = [];
  }
  
  users[userId].transactions.push(transaction);
  return transaction;
}

// Calculate swap with 0.5% fee
function calculateSwap(amount, fromRate, toRate) {
  const fee = 0.005; // 0.5% fee
  const amountAfterFee = amount * (1 - fee);
  const received = (amountAfterFee * fromRate) / toRate;
  return {
    received: received,
    fee: amount * fee,
    feePercent: fee * 100
  };
}

// ===============================
// WEBHOOK SETUP
// ===============================
async function setupWebhook() {
  try {
    await bot.setWebHook(webhookUrl);
    console.log(`✅ Webhook set to: ${webhookUrl}`);
  } catch (error) {
    console.error("❌ Failed to set webhook:", error.message);
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
      delete swapStates[userId];
      delete bankAccountStates[userId];
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(chatId, "🏠 Main Menu", defaultKeyboard);
    }

    // SHARE REFERRAL
    if (data === "share_referral") {
      const referralLink = `https://t.me/${(await bot.getMe()).username}?start=${user.referralCode}`;
      await bot.answerCallbackQuery(q.id);
      
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
              [{ text: "📤 Share Now", url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent("Join Aerosoft Trade Bot and get ₦500 bonus!")}` }],
              [{ text: "⬅️ Back", callback_data: "back_to_referral" }]
            ]
          }
        }
      );
    }

    // MY REFERRALS
    if (data === "my_referrals") {
      await bot.answerCallbackQuery(q.id);
      
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
      await bot.answerCallbackQuery(q.id);
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
      await bot.answerCallbackQuery(q.id, { text: "✅ All rewards are automatically added to your Naira wallet!", show_alert: true });
      return;
    }

    // SWAP ACTIONS
    if (data.startsWith("swap_")) {
      const swapType = data.replace("swap_", "");
      swapStates[userId] = { step: "amount", swapType };
      
      await bot.answerCallbackQuery(q.id);
      
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
      
      // Execute swap
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
        { chat_id: chatId, message_id: q.message.message_id }
      );
    }

    // WITHDRAW ACTIONS FOR CRYPTO
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

    // BANK ACCOUNT MANAGEMENT
    if (data === "add_bank_account") {
      bankAccountStates[userId] = { step: "select_bank" };
      
      // Create bank selection keyboard
      const bankButtons = NIGERIAN_BANKS.map(bank => [{
        text: bank,
        callback_data: `bank_selected_${bank.replace(/\s+/g, '_')}`
      }]);
      
      bankButtons.push([{ text: "❌ Cancel", callback_data: "cancel_action" }]);
      
      await bot.answerCallbackQuery(q.id);
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
      const bank = data.replace("bank_selected_", "").replace(/_/g, ' ');
      bankAccountStates[userId] = {
        step: "enter_account_number",
        bank: bank
      };
      
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(
        chatId,
        `🏦 Bank: ${bank}\n\nPlease enter your 10-digit account number:`,
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
      await bot.answerCallbackQuery(q.id);
      
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
      return bot.sendMessage(
        chatId,
        `🏦 Your Bank Details:\n\n` +
        `Bank: ${bankDetails.bank}\n` +
        `Account Number: ${bankDetails.accountNumber}\n` +
        `Account Name: ${bankDetails.accountName}\n` +
        `Added: ${new Date(bankDetails.addedAt).toLocaleDateString()}\n\n` +
        `To update your details, use the '✏️ Update Bank Account' option.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✏️ Update", callback_data: "update_bank_account" }],
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
      
      bankAccountStates[userId] = { step: "select_bank" };
      
      const bankButtons = NIGERIAN_BANKS.map(bank => [{
        text: bank,
        callback_data: `update_bank_selected_${bank.replace(/\s+/g, '_')}`
      }]);
      
      bankButtons.push([{ text: "❌ Cancel", callback_data: "cancel_action" }]);
      
      await bot.answerCallbackQuery(q.id);
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

    if (data.startsWith("update_bank_selected_")) {
      const bank = data.replace("update_bank_selected_", "").replace(/_/g, ' ');
      bankAccountStates[userId] = {
        step: "enter_account_number_update",
        bank: bank
      };
      
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(
        chatId,
        `✏️ Updating Bank Account\n\n` +
        `New Bank: ${bank}\n\n` +
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
      
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(
        chatId,
        `⚠️ Confirm Bank Account Removal\n\n` +
        `Bank: ${user.bankAccount.bank}\n` +
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
      const oldBank = user.bankAccount;
      user.bankAccount = null;
      
      await bot.answerCallbackQuery(q.id, { 
        text: "✅ Bank account removed successfully", 
        show_alert: true 
      });
      
      return bot.editMessageText(
        "✅ Bank account removed successfully",
        { chat_id: chatId, message_id: q.message.message_id }
      );
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
      
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(
        chatId,
        `💰 Withdraw to Bank\n\n` +
        `🏦 Bank: ${user.bankAccount.bank}\n` +
        `👤 Account: ${user.bankAccount.accountName}\n\n` +
        `Available Balance: ₦${formatNumber(user.naira)}\n\n` +
        `Enter amount to withdraw:`,
        {
          reply_markup: {
            inline_keyboard: [
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
      
      // Check if still sufficient balance
      if (user.naira < amount) {
        await bot.answerCallbackQuery(q.id, { text: "❌ Insufficient balance", show_alert: true });
        return;
      }

      // Create withdrawal transaction
      const transaction = createTransaction(userId, 'withdrawal', netAmount, {
        currency: 'NGN',
        bank: user.bankAccount.bank,
        accountNumber: user.bankAccount.accountNumber,
        accountName: user.bankAccount.accountName,
        amount: amount,
        fee: fee,
        netAmount: netAmount
      });

      // Process withdrawal
      user.naira -= amount;
      transaction.status = 'completed';
      transaction.completedAt = new Date().toISOString();
      
      delete withdrawStates[userId];
      
      await bot.answerCallbackQuery(q.id, { text: "✅ Withdrawal successful!", show_alert: true });
      
      return bot.editMessageText(
        `✅ Withdrawal Successful!\n\n` +
        `💰 Amount: ₦${formatNumber(amount)}\n` +
        `💸 Fee: ₦${formatNumber(fee)}\n` +
        `📥 Net Received: ₦${formatNumber(netAmount)}\n\n` +
        `🏦 Bank: ${user.bankAccount.bank}\n` +
        `👤 Account: ${user.bankAccount.accountName} (${user.bankAccount.accountNumber})\n\n` +
        `📊 New Balance: ₦${formatNumber(user.naira)}\n` +
        `📝 Transaction ID: ${transaction.id}\n\n` +
        `💰 Funds will arrive within 24 hours.`,
        { chat_id: chatId, message_id: q.message.message_id }
      );
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
// ===============================
// MESSAGE HANDLER
// ===============================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text?.trim();

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
      
      let welcomeMsg = `👋 Welcome to Aerosoft Trade Bot!\n\n`;
      
      if (referredBy) {
        welcomeMsg += `🎉 You joined using a referral link!\n`;
        welcomeMsg += `💰 You received ₦500 bonus in your Naira wallet!\n\n`;
        users[userId].naira += 500;
      }
      
      welcomeMsg += `✨ *Complete Features:*\n`;
      welcomeMsg += `✅ Crypto Wallets (BTC, ETH, SOL, USDT)\n`;
      welcomeMsg += `✅ Bank Withdrawals\n`;
      welcomeMsg += `✅ Crypto Swaps\n`;
      welcomeMsg += `✅ Referral System\n`;
      welcomeMsg += `✅ Live Exchange Rates\n\n`;
      welcomeMsg += `💡 *Tip:* Add your bank account first to enable withdrawals!`;
      
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
        
        // Save bank account
        user.bankAccount = {
          bank: bankState.bank,
          accountNumber: bankState.accountNumber,
          accountName: accountName,
          addedAt: new Date().toISOString(),
          verified: false
        };
        
        delete bankAccountStates[userId];
        
        return bot.sendMessage(
          chatId,
          `✅ Bank Account Added Successfully!\n\n` +
          `🏦 Bank: ${user.bankAccount.bank}\n` +
          `🔢 Account Number: ${user.bankAccount.accountNumber}\n` +
          `👤 Account Name: ${user.bankAccount.accountName}\n\n` +
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
        
        // Update bank account
        user.bankAccount = {
          bank: bankState.bank,
          accountNumber: bankState.accountNumber,
          accountName: accountName,
          addedAt: new Date().toISOString(),
          verified: false
        };
        
        delete bankAccountStates[userId];
        
        return bot.sendMessage(
          chatId,
          `✅ Bank Account Updated Successfully!\n\n` +
          `🏦 Bank: ${user.bankAccount.bank}\n` +
          `🔢 Account Number: ${user.bankAccount.accountNumber}\n` +
          `👤 Account Name: ${user.bankAccount.accountName}\n\n` +
          `Your bank details have been updated.`,
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
      
      // Calculate fee (1.5% with minimum of ₦50)
      const feePercentage = 0.015; // 1.5%
      const calculatedFee = amount * feePercentage;
      const fee = Math.max(calculatedFee, 50); // Minimum ₦50
      const netAmount = amount - fee;
      
      // Check minimum withdrawal (₦500)
      if (netAmount < 500) {
        return bot.sendMessage(
          chatId,
          `❌ Minimum withdrawal is ₦500 after fees.\n\n` +
          `Amount: ₦${formatNumber(amount)}\n` +
          `Fee: ₦${formatNumber(fee)}\n` +
          `Net: ₦${formatNumber(netAmount)}\n\n` +
          `Please enter a larger amount.`
        );
      }
      
      withdrawState.step = "confirm";
      withdrawState.amount = amount;
      withdrawState.fee = fee;
      withdrawState.netAmount = netAmount;
      
      return bot.sendMessage(
        chatId,
        `⚠️ Confirm Bank Withdrawal\n\n` +
        `🏦 Bank: ${user.bankAccount.bank}\n` +
        `👤 Account: ${user.bankAccount.accountName} (${user.bankAccount.accountNumber})\n\n` +
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

    // ===============================
    // MAIN MENU COMMANDS - FIXED SECTION
    // ===============================
    switch (text) {
      case "🏦 Bank Account":
        return bot.sendMessage(
          chatId,
          `🏦 Bank Account Management\n\n` +
          `Manage your bank details for withdrawals.\n\n` +
          `Status: ${user.bankAccount ? '✅ Added' : '❌ Not Added'}\n` +
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
        const nairaMsg = `💰 Naira Wallet\n\n` +
          `Balance: ₦${formatNumber(user.naira)}\n` +
          `Bank Account: ${user.bankAccount ? '✅ Added' : '❌ Not Added'}\n\n`;
        
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

      // SWAP PAIRS
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
            `📊 Live Exchange Rates\n\n` +
            `₿ BTC: ₦${formatNumber(rates.btc.ngn)} ($${formatNumber(rates.btc.usd)})\n` +
            `💵 ETH: ₦${formatNumber(rates.eth.ngn)} ($${formatNumber(rates.eth.usd)})\n` +
            `🟣 SOL: ₦${formatNumber(rates.sol.ngn)} ($${formatNumber(rates.sol.usd)})\n` +
            `🌐 USDT: ₦${formatNumber(rates.usdt.ngn)} ($${formatNumber(rates.usdt.usd)})\n\n` +
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
          `3. *Swap Crypto*: Use "🔄 Swap Crypto" menu\n` +
          `4. *Refer & Earn*: Share your referral link\n` +
          `5. *View Rates*: Get live exchange rates\n\n` +
          `🔄 *Swap Features:*\n` +
          `• BTC ↔ USDT\n` +
          `• ETH ↔ USDT\n` +
          `• SOL ↔ USDT\n` +
          `• 0.5% transaction fee\n\n` +
          `🎁 *Referral Program:*\n` +
          `• Earn ₦100 per referral\n` +
          `• Friends get ₦500 bonus\n` +
          `• Unlimited earnings!\n\n` +
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
    service: "Aerosoft Trade Bot",
    users: Object.keys(users).length,
    bankAccounts: Object.keys(users).filter(id => users[id].bankAccount).length,
    totalWithdrawals: Object.keys(users).reduce((sum, id) => 
      sum + (users[id].transactions?.filter(t => t.type === 'withdrawal').length || 0), 0),
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
const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  
  // Replit standard domain
  const replitDomain = process.env.REPL_SLUG && process.env.REPL_OWNER 
    ? `${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.replit.app`
    : null;

  if (replitDomain && !process.env.WEBHOOK_URL) {
    webhookUrl = `https://${replitDomain}/webhook`;
  }

  console.log(`🌐 Webhook URL: ${webhookUrl}`);
  
  await setupWebhook();
  console.log(`🤖 Bot initialized`);
  console.log(`✨ All Features: ✅`);
  console.log(`  • Crypto Wallets (BTC, ETH, SOL, USDT, NGN)`);
  console.log(`  • Bank Account Management`);
  console.log(`  • Bank Withdrawals`);
  console.log(`  • Crypto Swap (6 pairs)`);
  console.log(`  • Referral System`);
  console.log(`  • Live Exchange Rates`);
});

// Keep alive for Replit
setInterval(() => {
  axios.get(`https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`)
    .catch(() => console.log('🏓 Keep alive ping'));
}, 300000);