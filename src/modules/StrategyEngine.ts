import { NadoExchange } from "../exchanges/nado.js";
import { HyperliquidExchange } from "../exchanges/hyperliquid.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { telegram } from "../utils/telegram.js";
import { OrderSide, OrderType, MarketState, Order } from "../core/types.js";
import { mean } from "mathjs";

export class StrategyEngine {
    private nado: NadoExchange;
    private hyena: HyperliquidExchange;
    private isRunning: boolean = false;

    // Strategy Logic State
    private inventory: number = 0;
    private lastPrice: number = 0;
    private openOrders: Map<string, string> = new Map(); // side_index -> orderId
    private lastCandleUpdate: number = 0;
    private currentVolMult: number = 1.0;

    // Re-lock Loop
    private isProcessing: boolean = false;
    private lastTickTime: number = 0;

    // Circuit Breaker State
    private initialBalance: number = 0;
    private isCircuitOpen: boolean = false;
    private circuitResumeTimer: NodeJS.Timeout | null = null;

    // Volume Tracking
    private totalVolumeUSD: number = 0;

    constructor() {
        this.nado = new NadoExchange();
        this.hyena = new HyperliquidExchange();
    }

    public async start() {
        logger.info("🚀 Starting Hyper-Grid MM Bot (Nado-First)...");

        await this.nado.connect();

        // Always connect Hyena for Data (ATR), even if Hedging disabled
        await this.hyena.connect();

        this.isRunning = true;
        this.setupEventListeners();

        // Initialize Telegram Bot Commands
        telegram.registerCommands({
            getStatus: () => {
                const mid = this.lastPrice ? this.lastPrice.toFixed(1) : "N/A";
                const volMult = this.currentVolMult ? this.currentVolMult.toFixed(2) : "N/A";
                const inv = this.inventory.toFixed(4);
                const bal = this.initialBalance.toFixed(2);
                const vol = this.totalVolumeUSD.toFixed(2);

                return `🤖 **Bot Status**
Running: ${this.isRunning ? "✅ Yes" : "🛑 No"}
💰 Balance: $${bal}
📊 Volume: $${vol}
Mid: $${mid}
Inv: ${inv} BTC (x${volMult})
Active Orders: ${this.activeOrdersMap.size}
🔀 Hedging: ${config.ENABLE_HEDGING ? "On" : "Off"}`;
            },
            getBalance: async () => {
                const balance = await this.nado.getBalance();
                const inventoryVal = this.inventory * (this.lastPrice || 0);
                return `💰 Balance: $${balance.toFixed(2)}
📦 Inventory: ${this.inventory.toFixed(4)} BTC
💵 Notional Value: $${inventoryVal.toFixed(2)}`;
            },
            getPnl: async () => {
                return `💰 PnL Tracking is not yet fully implemented.
Current Inventory: ${this.inventory.toFixed(4)} BTC`;
            },
            getVolume: () => {
                return `📊 **Trading Volume (This Session)**
💰 Total Volume: $${this.totalVolumeUSD.toFixed(2)}
📈 Trade Count: ${Math.round(this.totalVolumeUSD / (this.lastPrice * 0.005) || 0)} (Est.)`;
            },
            getHealth: () => {
                const now = Date.now();
                const tickAge = this.lastTickTime > 0 ? Math.round((now - this.lastTickTime) / 1000) : -1;
                const isHealthy = tickAge >= 0 && tickAge < 30; // Healthy if tick within 30 sec

                return `🏥 **Health Check**
${isHealthy ? "✅" : "⚠️"} Status: ${isHealthy ? "Healthy" : "WARNING"}
🤖 Running: ${this.isRunning ? "Yes" : "No"}
🔌 Last Tick: ${tickAge >= 0 ? tickAge + "s ago" : "N/A"}
📡 Orders: ${this.activeOrdersMap.size}
🚨 Circuit: ${this.isCircuitOpen ? "OPEN (Paused)" : "Closed"}
💰 Balance: $${this.initialBalance.toFixed(2)}`;
            },
            stopBot: async () => {
                this.isRunning = false;
                await this.cancelAllOrders();
                logger.warn("🛑 Bot stopped by Telegram command. All orders cancelled.");
                telegram.sendMessage("🛑 **Bot 중지됨**\n모든 주문이 취소되었습니다.\n/start로 재개할 수 있습니다.");
            },
            startBot: async () => {
                // Clear any pending circuit breaker timer
                if (this.circuitResumeTimer) {
                    clearTimeout(this.circuitResumeTimer);
                    this.circuitResumeTimer = null;
                }
                this.isCircuitOpen = false;
                this.isRunning = true;
                this.initialBalance = await this.nado.getBalance(); // Reset baseline on manual resume
                await this.cancelAllOrders();
                this.runLoop();
                logger.info("🚀 Bot resumed by Telegram command. Circuit reset. Fresh start.");
                telegram.sendMessage("🚀 **Bot 수동 재개**\n새 기준 자산으로 서킷 브레이커가 리셋되었습니다.");
            }
        });

        // Start Circuit Breaker Check Interval (every 60 seconds)
        setInterval(async () => {
            if (this.isRunning && !this.isCircuitOpen) {
                await this.checkCircuitBreaker();
            }
        }, 60000);

        // Start MM Loop
        this.runLoop();
    }

    private setupEventListeners() {
        this.nado.on('fill', async (fill) => {
            const size = typeof fill.size === 'string' ? parseFloat(fill.size) : fill.size;
            const change = fill.side === 'buy' ? size : -size;

            this.inventory += change;

            // Track Volume
            const tradeValueUSD = size * fill.price;
            this.totalVolumeUSD += tradeValueUSD;

            logger.info(`🔔 [FILL] ${fill.side.toUpperCase()} ${size} @ ${fill.price}. Inv: ${this.inventory.toFixed(4)} | Vol: $${this.totalVolumeUSD.toFixed(2)}`);

            // Send Telegram Notification
            telegram.sendTradeNotification(fill.side, size, fill.price, this.inventory);

            // Check Hedging Condition
            if (config.ENABLE_HEDGING) {
                const posValue = Math.abs(this.inventory * fill.price);
                if (posValue > config.HEDGE_THRESHOLD_USD) {
                    logger.warn(`⚠️ Hedge Triggered! PosVal: $${posValue.toFixed(0)}`);
                    // Execute Hedge Logic Here (Basic Taker)
                    const hedgeSide = fill.side === 'buy' ? OrderSide.SELL : OrderSide.BUY;
                    await this.hyena.placeOrder({
                        symbol: config.TARGET_SYMBOL_HYENA,
                        side: hedgeSide,
                        type: OrderType.MARKET,
                        size: size,
                        price: hedgeSide === OrderSide.BUY ? fill.price * 1.05 : fill.price * 0.95 // 5% slip
                    });
                }
            }
        });
    }

    // Active Orders State: side_index -> { id, price, size, timestamp }
    private activeOrdersMap: Map<string, { id: string, price: number, size: number, timestamp: number }> = new Map();

    private async runLoop() {
        // Fetch Initial Balance on first run
        if (this.initialBalance === 0) {
            this.initialBalance = await this.nado.getBalance();
            logger.info(`[Circuit] Initial Balance: $${this.initialBalance.toFixed(2)}`);

            // Send Boot Notification (after balance is fetched)
            telegram.sendMessage(`🚀 **Nado Grid Bot 시작!**
💰 초기 자산: $${this.initialBalance.toFixed(2)}
🎯 거래쌍: ${config.TARGET_SYMBOL_NADO}
🔀 헷징: ${config.ENABLE_HEDGING ? "활성화" : "비활성화"}
📱 명령어: /s, /b, /v, /stop`);
        }

        while (this.isRunning) {
            // Skip if Circuit Breaker is open
            if (this.isCircuitOpen) {
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }

            try {
                if (!this.isProcessing) {
                    this.isProcessing = true;

                    await this.executeTick();
                    await this.pruneZombieOrders();
                    this.isProcessing = false;
                }
            } catch (e) {
                logger.error(`Loop Error: ${e}`);
                this.isProcessing = false;
            }

            // Random Jitter
            const delay = Math.floor(Math.random() * (config.JITTER_MAX_MS - config.JITTER_MIN_MS + 1)) + config.JITTER_MIN_MS;
            await new Promise(r => setTimeout(r, delay));
        }
    }

    private async checkCircuitBreaker() {
        if (this.initialBalance <= 0) return; // No baseline yet

        const currentBalance = await this.nado.getBalance();
        const drawdown = (currentBalance - this.initialBalance) / this.initialBalance;

        if (drawdown <= -config.CIRCUIT_BREAKER_THRESHOLD) {
            logger.error(`🚨 [CIRCUIT BREAKER] Drawdown ${(drawdown * 100).toFixed(2)}% exceeded threshold! Pausing for 30 minutes.`);

            // Send Telegram Alert
            telegram.sendMessage(`🚨 **서킷 브레이커 발동!**
손실률: ${(drawdown * 100).toFixed(2)}%
초기 자산: $${this.initialBalance.toFixed(2)}
현재 자산: $${currentBalance.toFixed(2)}
⏸️ 30분간 거래를 일시 중지합니다.`);

            // Trigger Circuit Breaker
            this.isCircuitOpen = true;
            await this.cancelAllOrders();

            // Schedule Auto-Resume after 30 minutes
            this.circuitResumeTimer = setTimeout(async () => {
                this.isCircuitOpen = false;
                this.initialBalance = await this.nado.getBalance(); // Reset baseline
                logger.info("⏰ [CIRCUIT] 30분 경과. 거래 자동 재개.");
                telegram.sendMessage("⏰ **서킷 브레이커 해제**\n30분 경과. 거래가 자동으로 재개됩니다.");
            }, config.CIRCUIT_BREAKER_COOLDOWN_MS);
        }
    }

    private async pruneZombieOrders() {
        const now = Date.now();
        const timeout = config.ZOMBIE_ORDER_MS || 900000; // 15 mins default

        for (const [key, active] of this.activeOrdersMap.entries()) {
            if (now - active.timestamp > timeout) {
                logger.warn(`👻 Zombie Order Detected: ${key} (Age: ${((now - active.timestamp) / 60000).toFixed(1)}m). Force Cancelling...`);
                try {
                    await this.nado.cancelOrder(config.TARGET_SYMBOL_NADO, active.id);
                } catch (e) {
                    logger.error(`Failed to cancel zombie ${key}: ${e}`);
                }
                // Always remove from map to allow new orders
                this.activeOrdersMap.delete(key);
            }
        }
    }

    private async executeTick() {
        // Update last tick time
        this.lastTickTime = Date.now();

        // 1. Get Market Data
        const book = await this.nado.getStartOrderBook(config.TARGET_SYMBOL_NADO);
        if (book.lastPrice <= 0) return;
        this.lastPrice = book.lastPrice;

        // 2. Update ATR (Every 1 minute max, or if not init)
        const now = Date.now();
        if (now - this.lastCandleUpdate > 60000) {
            await this.updateATR(this.lastPrice);
            this.lastCandleUpdate = now;
        }

        // 3. Refresh Orders
        await this.refreshGridOrders();
    }

    private async updateATR(currentPrice: number) {
        // Fetch Candles from Hyena
        const candles = await this.hyena.getCandles(config.TARGET_SYMBOL_HYENA, config.ATR_INTERVAL, config.ATR_PERIOD + 2);

        if (!candles || candles.length < config.ATR_PERIOD + 1) {
            this.currentVolMult = 1.0;
            return;
        }

        // Calculate ATR (Same as Python Bot)
        // Candles: {t, T, o, c, h, l, v, n}

        const trList: number[] = [];
        for (let i = 1; i < candles.length; i++) {
            const high = parseFloat(candles[i].h);
            const low = parseFloat(candles[i].l);
            const prevClose = parseFloat(candles[i - 1].c);

            const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            trList.push(tr);
        }

        // Slice to Period
        const period = config.ATR_PERIOD;
        if (trList.length < period) return;

        // Initial Mean
        const initialTRs = trList.slice(0, period);
        let atr = mean(initialTRs);

        // Smoothing (Wilder's)
        const remainingTRs = trList.slice(period);
        for (const tr of remainingTRs) {
            atr = (tr / period) + (atr * (1 - 1 / period));
        }

        // Calculate Multiplier
        if (currentPrice > 0) {
            const volMult = (atr / currentPrice) / config.BASE_SPREAD;
            this.currentVolMult = Math.max(config.VOL_MULTIPLIER_MIN, Math.min(config.VOL_MULTIPLIER_MAX, volMult));
            logger.info(`[ATR] Value: ${atr.toFixed(2)} | Mult: ${this.currentVolMult.toFixed(2)}x`);
        }
    }

    private async cancelAllOrders() {
        logger.info("[STRAT] Cancelling ALL Orders...");
        for (const [key, orderInfo] of this.activeOrdersMap.entries()) {
            try {
                await this.nado.cancelOrder(config.TARGET_SYMBOL_NADO, orderInfo.id);
            } catch (e) {
                logger.error(`[STRAT] Failed to cancel ${key} (${orderInfo.id}): ${e}`);
            }
        }
        this.activeOrdersMap.clear();
        logger.info("[STRAT] All orders cleared.");
    }


    private async refreshGridOrders() {
        const mid = this.lastPrice;
        const volMult = this.currentVolMult;

        // ... (rest is same)

        // Update usages:
        // this.activeOrdersMap.set(key, { id: newId, price: target.price, size: target.size, timestamp: Date.now() });

        const posValue = this.inventory * mid;
        const posRatio = posValue / config.MAX_POSITION_USD;
        // invAdj calculation...
        const invAdj = posRatio * config.INVENTORY_SKEW_MULTIPLIER;

        const longSpreads = config.LONG_SPREADS.map(s => Math.max(0.0001, s * (1 + invAdj) * volMult));
        const shortSpreads = config.SHORT_SPREADS.map(s => Math.max(0.0001, s * (1 - invAdj) * volMult));
        const ratios = config.ORDER_RATIOS;

        // 1. Calculate Target Orders
        const targetOrders: { key: string, order: Order }[] = [];

        // Buys
        if (posValue < config.MAX_POSITION_USD) {
            longSpreads.forEach((spread, i) => {
                if (i >= ratios.length) return;
                const ratio = ratios[i];
                const price = Math.floor(mid * (1 - spread) * 10) / 10;
                const usdSize = config.ORDER_SIZE_USD * ratio;
                const rawSize = usdSize / price;
                const stepSize = 0.00005;
                const size = parseFloat((Math.ceil(rawSize / stepSize) * stepSize).toFixed(5));

                if (size > 0 && usdSize >= 100) {
                    targetOrders.push({
                        key: `buy_${i}`,
                        order: {
                            symbol: config.TARGET_SYMBOL_NADO,
                            side: OrderSide.BUY,
                            type: OrderType.POST_ONLY,
                            price: price,
                            size: size
                        }
                    });
                }
            });
        }

        // Sells
        if (posValue > -config.MAX_POSITION_USD) {
            shortSpreads.forEach((spread, i) => {
                if (i >= ratios.length) return;
                const ratio = ratios[i];
                const price = Math.ceil(mid * (1 + spread) * 10) / 10;
                const usdSize = config.ORDER_SIZE_USD * ratio;
                const rawSize = usdSize / price;
                const stepSize = 0.00005;
                const size = parseFloat((Math.ceil(rawSize / stepSize) * stepSize).toFixed(5));

                if (size > 0 && usdSize >= 100) {
                    targetOrders.push({
                        key: `sell_${i}`,
                        order: {
                            symbol: config.TARGET_SYMBOL_NADO,
                            side: OrderSide.SELL,
                            type: OrderType.POST_ONLY,
                            price: price,
                            size: size
                        }
                    });
                }
            });
        }

        logger.info(`[STRAT] Mid:${mid.toFixed(1)} Vol:${volMult.toFixed(2)}x Inv:${this.inventory.toFixed(4)} Targets:${targetOrders.length}`);

        // 2. Diff & Execute
        // Track seen keys to prune others later
        const seenKeys = new Set<string>();

        for (const item of targetOrders) {
            const key = item.key;
            const target = item.order;
            seenKeys.add(key);

            const active = this.activeOrdersMap.get(key);

            if (active) {
                // Check tolerance
                const priceDiff = Math.abs(active.price - target.price);
                const sizeDiffRatio = Math.abs(active.size - target.size) / target.size;

                // Threshold Check: Price Diff > REPRICE_THRESHOLD ($30)
                // AND Asymmetric Logic:
                // - Buy: Only move UP (Chase). If price drops (comes to us), HOLD unless gap is huge (>$200).
                // - Sell: Only move DOWN (Chase). If price rises (comes to us), HOLD unless gap is huge (>$200).

                let shouldReprice = false;
                const priceDiffVal = target.price - active.price; // New - Old

                if (Math.abs(priceDiff) < config.REPRICE_THRESHOLD && sizeDiffRatio < 0.05) {
                    shouldReprice = false; // Inside Deadband
                } else if (sizeDiffRatio > 0.05) {
                    shouldReprice = true; // Size changed significantly
                } else {
                    // Price Logic
                    const MAX_STALE_DIST = 200; // Force update if too far

                    if (target.side === OrderSide.BUY) {
                        if (priceDiffVal > 0) shouldReprice = true; // Price moved UP, Chase it
                        else if (priceDiffVal < -MAX_STALE_DIST) shouldReprice = true; // Dropped too much (Risk)
                        else shouldReprice = false; // Price Dropped (Good for fill), HOLD
                    } else {
                        if (priceDiffVal < 0) shouldReprice = true; // Price moved DOWN, Chase it
                        else if (priceDiffVal > MAX_STALE_DIST) shouldReprice = true; // Rose too much (Risk)
                        else shouldReprice = false; // Price Rose (Good for fill), HOLD
                    }
                }

                if (shouldReprice) {
                    // Replace
                    logger.info(`[STRAT] Modifying ${key}: $${active.price} -> $${target.price} (Size: ${active.size} -> ${target.size})`);
                    try { await this.nado.cancelOrder(config.TARGET_SYMBOL_NADO, active.id); } catch (e) { }
                    try {
                        const newId = await this.nado.placeOrder(target);
                        logger.info(`[STRAT] Placed Order ${newId}`);
                        this.activeOrdersMap.set(key, { id: newId, price: target.price, size: target.size, timestamp: Date.now() });
                    } catch (e) {
                        logger.error(`[STRAT] PlaceOrder Error for ${key} (replace): ${e}`);
                        this.activeOrdersMap.delete(key);
                    }
                } else {
                    // Keep (Do nothing)
                }
            } else {
                // Create New
                try {
                    const newId = await this.nado.placeOrder(target);
                    // logger.info(`[STRAT] Creating ${key} @ $${target.price}`);
                    this.activeOrdersMap.set(key, { id: newId, price: target.price, size: target.size, timestamp: Date.now() });
                } catch (e) { }
            }
        }

        // 3. Prune (Cancel orders that are no longer in target list)
        for (const key of this.activeOrdersMap.keys()) {
            if (!seenKeys.has(key)) {
                // Cancel
                const active = this.activeOrdersMap.get(key);
                if (active) {
                    // logger.info(`[STRAT] Pruning ${key}`);
                    try { await this.nado.cancelOrder(config.TARGET_SYMBOL_NADO, active.id); } catch (e) { }
                    this.activeOrdersMap.delete(key);
                }
            }
        }
    }

    // Deprecated but kept to satisfy interface if needed, or remove.
    // private async cancelMyOrders() ... REMOVED
}
