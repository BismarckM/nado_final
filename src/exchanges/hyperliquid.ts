import { BaseExchange } from "./base.js";
import { MarketState, Order, OrderSide, OrderType, Position } from "../core/types.js";
import { config } from "../config.js";
import { ExchangeClient, InfoClient, HttpTransport } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { logger } from "../utils/logger.js";

export class HyperliquidExchange extends BaseExchange {
    private exchange: ExchangeClient;
    private info: InfoClient;
    private account: any;
    private coinToIndexMap: Map<string, number> = new Map();

    constructor() {
        super("Hyena");

        if (!config.HYENA_PRIVATE_KEY) throw new Error("HYENA_PRIVATE_KEY missing");

        let pk = config.HYENA_PRIVATE_KEY;
        if (!pk.startsWith("0x")) pk = `0x${pk}`;
        this.account = privateKeyToAccount(pk as `0x${string}`);

        const transport = new HttpTransport({
            isTestnet: false,
            apiUrl: config.HYENA_API_URL
        });

        this.info = new InfoClient({ transport });
        this.exchange = new ExchangeClient({
            wallet: this.account,
            transport,
        });
    }

    public async connect(): Promise<boolean> {
        return this.safeExecute("Connect", async () => {
            logger.info(`[${this.name}] Connecting...`);

            try {
                const metaAndAssetCtxs = await this.info.metaAndAssetCtxs();
                const universe = metaAndAssetCtxs[0].universe;

                universe.forEach((u: any, index: number) => {
                    this.coinToIndexMap.set(u.name, index);
                });

                this.isConnected = true;
                logger.info(`[${this.name}] Connected to Hyperliquid Mainnet.`);

                // Leverage Setup (Cross)
                const btcId = this.coinToIndexMap.get("BTC");
                if (btcId !== undefined) {
                    try {
                        await this.exchange.updateLeverage({
                            asset: btcId,
                            isCross: true, // Cross Margin
                            leverage: config.LEVERAGE
                        });
                        logger.info(`[${this.name}] Set Leverage to ${config.LEVERAGE}x (Cross)`);
                    } catch (e) {
                        logger.warn(`[${this.name}] Leverage Update Failed: ${e}`);
                    }
                }

                return true;
            } catch (e) {
                logger.warn(`[${this.name}] Connection Warning: ${e}.`);
                return false;
            }
        });
    }

    public async getCandles(symbol: string, interval: string, limit: number = 20): Promise<any[]> {
        // Use raw fetch because SDK candle support varies
        // Request: { "type": "candleSnapshot", "req": { "coin": "BTC", "interval": "5m", "startTime": ... } }
        try {
            const intervalMsMap: { [key: string]: number } = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000 };
            const ms = intervalMsMap[interval] || 300000;
            const endTime = Date.now();
            const startTime = endTime - (ms * limit);

            const response = await fetch(`${config.HYENA_API_URL}/info`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    type: "candleSnapshot",
                    req: {
                        coin: symbol,
                        interval: interval,
                        startTime: startTime,
                        endTime: endTime
                    }
                })
            });

            if (response.ok) {
                const data = await response.json();
                return Array.isArray(data) ? data : [];
            }
            return [];
        } catch (e) {
            logger.error(`[${this.name}] Candle Fetch Failed: ${e}`);
            return [];
        }
    }

    public async getMidPrice(symbol: string): Promise<number> {
        const allMids = await this.info.allMids();
        if (allMids && allMids[symbol]) {
            return parseFloat(allMids[symbol]);
        }
        return 0;
    }

    public async getStartOrderBook(symbol: string): Promise<MarketState> {
        const mid = await this.getMidPrice(symbol);
        return {
            symbol,
            bid: mid,
            ask: mid,
            spread: 0,
            lastPrice: mid,
            inventory: 0
        };
    }

    public async placeOrder(order: Order): Promise<string> {
        if (!config.ENABLE_HEDGING) {
            return "skipped";
        }

        return this.safeExecute("PlaceOrder", async () => {
            const assetIndex = this.coinToIndexMap.get(order.symbol);
            if (assetIndex === undefined) throw new Error(`Unknown coin: ${order.symbol}`);

            const isBuy = order.side === OrderSide.BUY;
            const tif = "Ioc";

            const orderRequest = {
                orders: [{
                    a: assetIndex,
                    b: isBuy,
                    p: order.price.toString(),
                    s: order.size.toString(),
                    r: false,
                    t: { limit: { tif: tif as any } },
                }],
                grouping: "na"
            };

            const result = await this.exchange.order(orderRequest as any);
            const response = result.response;

            if (response.type === "order") {
                const status = response.data.statuses[0] as any;
                if (status.error) {
                    throw new Error(`Order Rejected: ${status.error}`);
                }
            }
            return `hyp-hedge-${Date.now()}`;
        });
    }

    public async cancelOrder(symbol: string, orderId: string): Promise<boolean> {
        return true;
    }

    public async getPosition(symbol: string): Promise<Position | null> {
        return null; // TODO: Implement if needed for precise hedging
    }

    public async getBalance(): Promise<number> {
        return 0;
    }
}
