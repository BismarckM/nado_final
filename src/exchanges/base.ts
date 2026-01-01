import { EventEmitter } from "events";
import { ExchangeClient, MarketState, Order, OrderSide, Position } from "../core/types.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";

export abstract class BaseExchange extends EventEmitter implements ExchangeClient {
    public name: string;
    protected isConnected: boolean = false;

    constructor(name: string) {
        super();
        this.name = name;
    }

    abstract connect(): Promise<boolean>;
    abstract getMidPrice(symbol: string): Promise<number>;
    abstract getStartOrderBook(symbol: string): Promise<MarketState>;
    abstract placeOrder(order: Order): Promise<string>;
    abstract cancelOrder(symbol: string, orderId: string): Promise<boolean>;
    abstract getPosition(symbol: string): Promise<Position | null>;
    abstract getBalance(): Promise<number>;

    protected validateOrder(order: Order) {
        if (order.size <= 0) throw new Error("Order size must be positive");
        if (order.price <= 0) throw new Error("Order price must be positive");
    }

    protected async safeExecute<T>(operation: string, fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (e: any) {
            logger.error(`[${this.name}] ${operation} Failed: ${e.message}`);
            throw e;
        }
    }
}
