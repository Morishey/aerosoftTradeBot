// payment-processor.js
const axios = require('axios');

class PaymentProcessor {
  constructor(provider = 'flutterwave') {
    this.provider = provider;
    this.init();
  }

  init() {
    if (this.provider === 'flutterwave') {
      this.baseURL = 'https://api.flutterwave.com/v3';
      this.headers = {
        Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
        'Content-Type': 'application/json'
      };
    } else if (this.provider === 'paystack') {
      this.baseURL = 'https://api.paystack.co';
      this.headers = {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      };
    }
  }

  // Verify bank account before transfer
  async verifyBankAccount(accountNumber, bankCode) {
    try {
      if (this.provider === 'flutterwave') {
        const response = await axios.post(
          `${this.baseURL}/accounts/resolve`,
          {
            account_number: accountNumber,
            account_bank: bankCode
          },
          { headers: this.headers }
        );
        return {
          success: true,
          accountName: response.data.data.account_name
        };
      } else if (this.provider === 'paystack') {
        const response = await axios.get(
          `${this.baseURL}/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
          { headers: this.headers }
        );
        return {
          success: true,
          accountName: response.data.data.account_name
        };
      }
    } catch (error) {
      console.error('Account verification failed:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || 'Account verification failed'
      };
    }
  }

  // Process actual bank transfer
  async processTransfer(transferData) {
    try {
      const { userId, amount, recipient, reference } = transferData;
      
      let payload;
      if (this.provider === 'flutterwave') {
        payload = {
          account_bank: recipient.bankCode,
          account_number: recipient.accountNumber,
          amount: Math.round(amount), // Amount in Naira
          narration: `Withdrawal from ${process.env.BUSINESS_NAME}`,
          currency: "NGN",
          reference: reference,
          beneficiary_name: recipient.accountName,
          callback_url: `${process.env.WEBHOOK_URL}/transfer-webhook`
        };
      } else if (this.provider === 'paystack') {
        payload = {
          source: "balance",
          amount: Math.round(amount * 100), // Paystack uses kobo
          recipient: recipient.transferCode || recipient.accountNumber,
          reason: `Withdrawal from ${process.env.BUSINESS_NAME}`
        };
      }

      const response = await axios.post(
        `${this.baseURL}/transfers`,
        payload,
        { headers: this.headers }
      );

      return {
        success: true,
        data: response.data,
        transferId: response.data.data.id || response.data.data.transfer_code
      };
    } catch (error) {
      console.error('Transfer failed:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || 'Transfer failed'
      };
    }
  }

  // Check transfer status
  async checkTransferStatus(transferId) {
    try {
      const response = await axios.get(
        `${this.baseURL}/transfers/${transferId}`,
        { headers: this.headers }
      );
      return response.data;
    } catch (error) {
      console.error('Status check failed:', error);
      return null;
    }
  }

  // Get bank list
  async getBanks() {
    try {
      const response = await axios.get(
        `${this.baseURL}/banks/NG`,
        { headers: this.headers }
      );
      return response.data.data;
    } catch (error) {
      console.error('Failed to fetch banks:', error);
      return NIGERIAN_BANKS.map(name => ({ name, code: name.slice(0, 3).toUpperCase() }));
    }
  }
}

module.exports = PaymentProcessor;