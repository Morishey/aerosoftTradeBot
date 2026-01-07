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
  // Use Replit's standard domain
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
const depositStates = {};

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
      usdt: { ngn: data.tether.ngn, usd: data.tether.usd },
      usd_ngn: { buy: 1440.00, sell: 1500.00 } // Added USD/NGN rates
    };
  } catch (error) {
    console.error("Failed to fetch rates:", error.message);
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
    return true;
  } catch (error) {
    console.error("❌ Failed to set webhook:", error.message);
    return false;
  }
}

// ===============================
// CALLBACK HANDLER (UPDATED WITH MISSING HANDLERS)
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
      delete depositStates[userId];
      await bot.answerCallbackQuery(q.id);
      return bot.sendMessage(chatId, "🏠 Main Menu", defaultKeyboard);
    }

    // REFRESH RATES (MISSING HANDLER ADDED)
    if (data === "refresh_rates") {
      await bot.answerCallbackQuery(q.id, { text: "🔄 Refreshing rates...", show_alert: false });
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
      } catch (error) {
        console.error("Error refreshing rates:", error);
        await bot.answerCallbackQuery(q.id, { text: "❌ Failed to refresh rates", show_alert: true });
      }
      return;
    }

    // DEPOSIT HANDLERS (MISSING HANDLERS ADDED)
    if (data.startsWith("deposit_")) {
      const wallet = data.replace("deposit_", "");
      await bot.answerCallbackQuery(q.id);
      
      let depositMsg = `📥 Deposit ${wallet.toUpperCase()}\n\n`;
      let address = "";
      
      switch(wallet) {
        case "naira":
          depositMsg += `To deposit Naira, please send to:\n`;
          depositMsg += `🏦 Bank: Aerosoft Bank\n`;
          depositMsg += `📞 Account: 0123456789\n`;
          depositMsg += `👤 Name: Aerosoft Trade\n\n`;
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

    // COPY ADDRESS HANDLER (NEW)
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
          { chat_id: chatId, message_id: q.message.message_id }
        );
      } else {
        await bot.answerCallbackQuery(q.id, { text: "❌ Insufficient balance", show_alert: true });
      }
      return;
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
      return;
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
// MESSAGE HANDLER (REMAINS SAME)
// ===============================
// ... (Keep the existing handleMessage function as is, it's already correct)
// The handleMessage function from your original code should remain unchanged

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
  
  // Get Replit domain
  const replitDomain = process.env.REPL_SLUG && process.env.REPL_OWNER 
    ? `${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`
    : null;

  if (replitDomain && !WEBHOOK_URL) {
    webhookUrl = `https://${replitDomain}/webhook`;
    console.log(`🌐 Using Replit domain: ${webhookUrl}`);
  }

  console.log(`🌐 Webhook URL: ${webhookUrl}`);
  
  const webhookResult = await setupWebhook();
  if (webhookResult) {
    console.log(`🤖 Bot initialized`);
    console.log(`✨ All Features: ✅`);
    console.log(`  • Crypto Wallets (BTC, ETH, SOL, USDT, NGN)`);
    console.log(`  • Bank Account Management`);
    console.log(`  • Bank Withdrawals`);
    console.log(`  • Crypto Swap (6 pairs)`);
    console.log(`  • Referral System`);
    console.log(`  • Live Exchange Rates`);
  } else {
    console.log(`❌ Bot initialization failed`);
  }
});

// Keep alive for Replit - use the correct domain
setInterval(() => {
  const domain = process.env.REPL_SLUG && process.env.REPL_OWNER 
    ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`
    : `http://localhost:${PORT}`;
  
  axios.get(domain)
    .then(() => console.log('🏓 Keep alive ping successful'))
    .catch(err => console.log('🏓 Keep alive ping failed:', err.message));
}, 300000); // Every 5 minutes