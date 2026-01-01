import { Telegraf } from 'telegraf';
import { config } from '../config.js';
import { logger } from './logger.js';

export interface BotCallbacks {
    getStatus: () => string;
    getBalance: () => Promise<string>;
    getPnl: () => Promise<string>;
    getVolume: () => string;
    getHealth: () => string;
    stopBot: () => void;
    startBot: () => void;
}

export class TelegramBot {
    private bot: Telegraf | null = null;
    private chatId: string;

    constructor() {
        if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
            this.bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
            this.chatId = config.TELEGRAM_CHAT_ID;
            logger.info("✅ Telegram Bot Initialized.");
        } else {
            logger.warn("⚠️ Telegram Bot Token or Chat ID missing. Notifications disabled.");
            this.chatId = "";
        }
    }

    public registerCommands(callbacks: BotCallbacks) {
        if (!this.bot) return;

        // Status: /status, /s, /stat
        const statusHandler = async (ctx: any) => {
            const status = callbacks.getStatus();
            await ctx.reply(status);
        };
        this.bot.command('status', statusHandler);
        this.bot.command('s', statusHandler);
        this.bot.command('stat', statusHandler);

        // Balance: /balance, /inv, /b, /bal
        const balanceHandler = async (ctx: any) => {
            await ctx.reply("⏳ Fetching balance...");
            const balance = await callbacks.getBalance();
            await ctx.reply(balance);
        };
        this.bot.command('balance', balanceHandler);
        this.bot.command('inv', balanceHandler);
        this.bot.command('b', balanceHandler);
        this.bot.command('bal', balanceHandler);

        // PnL: /pnl, /p
        const pnlHandler = async (ctx: any) => {
            await ctx.reply("⏳ Calculating PnL...");
            const pnl = await callbacks.getPnl();
            await ctx.reply(pnl);
        };
        this.bot.command('pnl', pnlHandler);
        this.bot.command('p', pnlHandler);

        // Volume: /volume, /vol, /v
        const volumeHandler = async (ctx: any) => {
            const volume = callbacks.getVolume();
            await ctx.reply(volume);
        };
        this.bot.command('volume', volumeHandler);
        this.bot.command('vol', volumeHandler);
        this.bot.command('v', volumeHandler);

        // Health: /health, /h
        const healthHandler = async (ctx: any) => {
            const health = callbacks.getHealth();
            await ctx.reply(health);
        };
        this.bot.command('health', healthHandler);
        this.bot.command('h', healthHandler);

        // Stop: /stop (no alias for safety)
        this.bot.command('stop', (ctx) => {
            callbacks.stopBot();
            ctx.reply("🛑 Bot stopped. Use /start to resume.");
        });

        // Start: /start (no alias for safety)
        this.bot.command('start', (ctx) => {
            callbacks.startBot();
            ctx.reply("🚀 Bot resumed by command.");
        });

        // Help: /help, /?
        const helpText = `📖 **Nado Grid Bot - 명령어 목록**

📊 **상태 조회**
• /s, /status - 봇 상태 요약
• /b, /bal, /balance - 잔고 조회
• /v, /vol, /volume - 거래량 조회
• /p, /pnl - 손익 조회
• /h, /health - 헬스 체크

⚙️ **봇 제어**
• /stop - 봇 중지 (주문 취소)
• /start - 봇 재개

❓ /help - 이 도움말`;
        this.bot.command('help', (ctx) => ctx.reply(helpText));
        this.bot.command('?', (ctx) => ctx.reply(helpText));

        // Start polling for commands
        this.bot.launch().catch(err => {
            logger.error(`[Telegram] Polling Error: ${err}`);
        });
        logger.info("[Telegram] Command Polling Started.");
    }

    public async sendMessage(message: string) {
        if (!this.bot || !this.chatId) return;

        try {
            await this.bot.telegram.sendMessage(this.chatId, message);
        } catch (e) {
            logger.error(`[Telegram] Failed to send message: ${e} `);
        }
    }

    public async sendTradeNotification(side: string, size: number, price: number, inventory: number, pnl?: number) {
        // 이모지 & 포맷팅
        const sideIcon = side.toUpperCase() === 'BUY' ? '🟢' : '🔴';
        const pnlText = pnl ? `\n💰 PnL: $${pnl.toFixed(2)} ` : '';
        const invText = `\n📦 Inv: ${inventory.toFixed(4)} BTC`;

        const message = `${sideIcon} ** [FILL] ${side.toUpperCase()}** ${size} BTC @$${price.toFixed(1)}
        ${invText}
        ${pnlText} `;

        await this.sendMessage(message);
    }
}

export const telegram = new TelegramBot();
