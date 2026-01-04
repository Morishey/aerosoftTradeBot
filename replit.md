# Aerosoft Trade Bot

## Overview
A Telegram bot for cryptocurrency trading simulation. Users can view wallet balances, check live crypto rates (via CoinGecko API), and swap between different cryptocurrencies.

## Project Structure
- `bot.js` - Main bot application with Express server for webhook handling
- `package.json` - Node.js dependencies

## Technologies
- Node.js with Express
- node-telegram-bot-api for Telegram integration
- axios for HTTP requests to CoinGecko API

## Environment Variables Required
- `TELEGRAM_TOKEN` - Your Telegram Bot API token (get from @BotFather)
- `WEBHOOK_URL` - The public URL where this bot is accessible (e.g., your Replit deployment URL)

## Running the Bot
The bot runs on port 5000 and exposes:
- `GET /` - Health check endpoint
- `POST /webhook` - Telegram webhook endpoint

## Features
- View wallet balances (Naira, ETH, BTC, USDT, SOL)
- Live cryptocurrency rates in NGN
- Swap between cryptocurrencies
- Referral system
