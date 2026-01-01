import { EventEmitter } from "events";

export enum OrderSide {
    BUY = 'buy',
    SELL = 'sell'
}

export enum OrderType {
    LIMIT = 'limit',
    MARKET = 'market',
    POST_ONLY = 'post_only'
}

export interface Order {
    symbol: string;
    side: OrderSide;
    type: OrderType;
    price: number;
    size: number;
    timestamp?: number;
    params?: any;
}

export interface MarketState {
    symbol: string;
    bid: number;
    ask: number;
    spread: number;
    lastPrice: number;
    inventory: number;
}

export interface Position {
    symbol: string;
    size: number;
    entryPrice: number;
    unrealizedPnl: number;
    leverage: number;
}

export interface ExchangeClient extends EventEmitter {
    connect(): Promise<boolean>;
    getMidPrice(symbol: string): Promise<number>;
    getStartOrderBook(symbol: string): Promise<MarketState>;
    placeOrder(order: Order): Promise<string>;
    cancelOrder(symbol: string, orderId: string): Promise<boolean>;
    getPosition(symbol: string): Promise<Position | null>;
    getBalance(): Promise<number>;
}
