import { createWalletClient, http, webSocket, createPublicClient, pad, parseUnits, formatUnits, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createNadoClient, NadoClient, getOrderNonce, packOrderAppendix } from "@nadohq/client";
import { BaseExchange } from "./base.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { OrderSide, OrderType, MarketState, Order, Position } from "../core/types.js";
import { subaccountToHex } from "@nadohq/shared";
// @ts-ignore
import WebSocket from "ws";

const inkMainnet = defineChain({
    id: 57073,
    name: 'Ink',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
        default: {
            http: ['https://rpc-qnd.inkonchain.com'],
            webSocket: ['wss://rpc-qnd.inkonchain.com']
        },
        public: {
            http: ['https://rpc-qnd.inkonchain.com'],
            webSocket: ['wss://rpc-qnd.inkonchain.com']
        }
    },
    blockExplorers: {
        default: { name: 'Explorer', url: 'https://explorer.inkonchain.com' }
    }
});

export class NadoExchange extends BaseExchange {
    private client: NadoClient | null = null;
    private productMap: Map<string, number> = new Map();
    private account: any;

    private ws: WebSocket | null = null;

    // OrderBook Cache (PriceStr -> SizeStr)
    private bidsMap = new Map<string, string>();
    private asksMap = new Map<string, string>();

    private latestBook: MarketState = {
        symbol: "BTC-PERP",
        bid: 0,
        ask: 0,
        spread: 0,
        lastPrice: 0,
        inventory: 0
    };

    constructor() {
        super("Nado");
        this.account = privateKeyToAccount(config.NADO_PRIVATE_KEY as `0x${string}`);
    }

    private updateLocalBook(bids: string[][], asks: string[][]) {
        for (const item of bids) {
            const price = item[0];
            const size = item[1];
            if (size === "0" || size === "0.0") {
                this.bidsMap.delete(price);
            } else {
                this.bidsMap.set(price, size);
            }
        }
        for (const item of asks) {
            const price = item[0];
            const size = item[1];
            if (size === "0" || size === "0.0") {
                this.asksMap.delete(price);
            } else {
                this.asksMap.set(price, size);
            }
        }
        this.recalculateTopBook();
    }

    private recalculateTopBook() {
        const SCALE = 1e18;
        let bestBid = 0;
        let bestAsk = 0;

        const sortedBids = Array.from(this.bidsMap.keys())
            .map(p => parseFloat(p))
            .sort((a, b) => b - a);

        const sortedAsks = Array.from(this.asksMap.keys())
            .map(p => parseFloat(p))
            .sort((a, b) => a - b);

        if (sortedBids.length > 0) bestBid = Math.round(sortedBids[0] / SCALE);
        if (sortedAsks.length > 0) bestAsk = Math.round(sortedAsks[0] / SCALE);

        if (bestBid > 0 && bestAsk > 0) {
            const mid = (bestBid + bestAsk) / 2;
            this.latestBook = {
                symbol: config.TARGET_SYMBOL_NADO,
                bid: bestBid,
                ask: bestAsk,
                spread: (bestAsk - bestBid) / mid,
                lastPrice: mid,
                inventory: 0
            };
        }
    }

    public async connect(): Promise<boolean> {
        return this.safeExecute("Connect", async () => {
            logger.info(`[${this.name}] Initializing SDK & WebSocket...`);

            const transport = config.NADO_RPC_URL.startsWith('wss') ? webSocket(config.NADO_RPC_URL) : http(config.NADO_RPC_URL);

            const walletClient = createWalletClient({
                account: this.account,
                chain: inkMainnet,
                transport: transport
            }) as any;

            const publicClient = createPublicClient({
                chain: inkMainnet,
                transport: transport
            }) as any;

            const nadoConfig: any = {
                contractAddresses: {
                    querier: '0x68798229F88251b31D534733D6C4098318c9dff8',
                    perpEngine: '0xF8599D58d1137fC56EcDd9C16ee139C8BDf96da1',
                    spotEngine: '0xFcD94770B95fd9Cc67143132BB172EB17A0907fE',
                    clearinghouse: '0xD218103918C19D0A10cf35300E4CfAfbD444c5fE',
                    endpoint: '0x05ec92D78ED421f3D3Ada77FFdE167106565974E',
                    withdrawPool: '0x09fb495AA7859635f755E827d64c4C9A2e5b9651'
                },
                engineEndpoint: "https://gateway.prod.nado.xyz/v1",
                indexerEndpoint: "https://archive.prod.nado.xyz/v1",
                triggerEndpoint: "https://trigger.prod.nado.xyz/v1"
            };

            this.client = createNadoClient(nadoConfig, {
                walletClient,
                publicClient
            });

            // 1. Fetch Dynamic Symbols
            const symbolsUrl = "https://gateway.prod.nado.xyz/v1/symbols";
            let btcPerpId = 0;

            try {
                const response = await fetch(symbolsUrl);
                // ... (rest of logic)
            } catch (e) { /* ... */ }

            // ...

            // 2. Setup WebSocket
            const wsUrl = "wss://gateway.prod.nado.xyz/v1/subscribe";
            this.ws = new WebSocket(wsUrl);

            return new Promise<boolean>((resolve, reject) => {
                if (!this.ws) return reject("WS failed");

                const pingInterval = setInterval(() => {
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        try {
                            this.ws.ping();
                        } catch (e) { }
                    } else {
                        clearInterval(pingInterval);
                    }
                }, 30000);

                this.ws.onopen = async () => {
                    logger.info(`[${this.name}] WS Open. Authenticating...`);
                    try {
                        await this.authenticate();

                        const targetId = this.productMap.get(config.TARGET_SYMBOL_NADO) || 2;

                        // Subscribe Book
                        this.ws?.send(JSON.stringify({
                            method: "subscribe",
                            stream: { type: "book_depth", product_id: targetId },
                            id: 100
                        }));

                        // Subscribe Fills
                        const subaccount = subaccountToHex({
                            subaccountOwner: this.account.address,
                            subaccountName: 'default'
                        });
                        this.ws?.send(JSON.stringify({
                            method: "subscribe",
                            stream: { type: "fill", product_id: null, subaccount: subaccount },
                            id: 101
                        }));

                        resolve(true);

                    } catch (e) {
                        logger.error(`[${this.name}] WS Setup Failed: ${e}`);
                        resolve(false);
                    }
                };

                this.ws.onmessage = (event: any) => {
                    try {
                        const msg = JSON.parse(event.data.toString());
                        if (msg.type === "ping") {
                            this.ws?.send(JSON.stringify({ type: "pong" }));
                            return;
                        }

                        const data = msg.data || msg;
                        if (data && (data.bids || data.asks)) {
                            this.updateLocalBook(data.bids || [], data.asks || []);
                        }

                        if (msg.type === "fill" || (msg.data && msg.data.type === "fill")) {
                            const fill = msg.data || msg;
                            const side = fill.is_bid ? 'buy' : 'sell';
                            const rawAmt = fill.filled_qty || fill.amount || "0";
                            const rawPx = fill.price || "0";
                            const amount = parseFloat(rawAmt) / 1e18;
                            const price = parseFloat(rawPx) / 1e18;

                            this.emit('fill', {
                                symbol: config.TARGET_SYMBOL_NADO,
                                side: side,
                                price: price,
                                size: amount,
                                orderId: fill.order_digest || fill.digest
                            });
                        }
                    } catch (e) { }
                };

                this.ws.onerror = (err: any) => {
                    logger.error(`[${this.name}] WS Error: ${err}`);
                };
            });
        });
    }

    public async getMidPrice(symbol: string): Promise<number> {
        return this.latestBook.lastPrice > 0 ? this.latestBook.lastPrice : 0;
    }

    public async getStartOrderBook(symbol: string): Promise<MarketState> {
        return { ...this.latestBook };
    }

    public async getBalance(): Promise<number> {
        return this.safeExecute("GetBalance", async () => {
            if (!this.client) return 0;
            const summary = await this.client.subaccount.getSubaccountSummary({
                subaccountOwner: this.account.address,
                subaccountName: 'default'
            });
            // collateralAmount is usually the cash balance. 
            // Depending on API, 'totalValue' or 'withdrawable' might be better for equity.
            // Using collateralAmount for now as base equity.
            // logger.info(`[Balance Debug] Summary: ${JSON.stringify(summary)}`);
            const summaryAny = summary as any;
            // Balance is in health.unweighted.assets based on debug log
            const balanceStr = summaryAny?.health?.unweighted?.assets || "0";
            const balanceRaw = parseFloat(balanceStr);
            const balance = balanceRaw / 1e18;
            return balance;
        });
    }

    public async placeOrder(order: Order): Promise<string> {
        return this.safeExecute("PlaceOrder", async () => {
            if (!this.client) throw new Error("Client not initialized");

            const isBuy = order.side === OrderSide.BUY;
            const targetId = this.productMap.get(order.symbol) || 2;
            const signedSize = isBuy ? order.size : -order.size;

            const absSizeStr = Math.abs(signedSize).toString();
            const scaledSize = parseUnits(absSizeStr, 18);
            const finalAmount = signedSize < 0 ? -scaledSize : scaledSize;

            const priceStr = Math.round(order.price).toString();
            const expiration = Math.floor(Date.now() / 1000) + 90 * 86400;
            const nonce = getOrderNonce();

            const appendixParams: any = {};
            if (order.type === OrderType.POST_ONLY) {
                appendixParams.orderExecutionType = 'post_only';
            }
            const packedAppendix = packOrderAppendix(appendixParams);

            const marketApi = this.client.market as any;
            const result = await marketApi.placeOrders({
                orders: [{
                    productId: targetId,
                    order: {
                        subaccountOwner: this.account.address,
                        subaccountName: 'default',
                        sender: this.account.address,
                        expiration: expiration.toString(),
                        price: priceStr,
                        amount: finalAmount.toString(),
                        nonce: nonce,
                        appendix: packedAppendix.toString()
                    }
                }]
            });

            const digest = result?.data?.[0]?.digest || result?.orders?.[0]?.digest || `nado-${nonce}`;
            return digest;
        });
    }

    public async cancelOrder(symbol: string, orderId: string): Promise<boolean> {
        return this.safeExecute("CancelOrder", async () => {
            if (!this.client) throw new Error("Client not initialized");
            const targetId = this.productMap.get(symbol) || 2;
            const marketApi = this.client.market as any;

            try {
                await marketApi.cancelOrders({
                    subaccountName: 'default',
                    productIds: [targetId],
                    digests: [orderId]
                });
            } catch (e: any) {
                // Legacy retry
                await marketApi.cancelOrders({
                    subaccountOwner: this.account.address,
                    subaccountName: 'default',
                    orders: [{ marketId: targetId, orderId: orderId, digest: orderId }]
                });
            }
            return true;
        });
    }

    private async authenticate() {
        const domain = {
            name: "Nado",
            version: "0.0.1",
            chainId: config.NADO_CHAIN_ID,
            verifyingContract: "0x05ec92D78ED421f3D3Ada77FFdE167106565974E" as `0x${string}`
        };
        const types = {
            StreamAuthentication: [
                { name: "sender", type: "bytes32" },
                { name: "expiration", type: "uint64" }
            ]
        };
        const sender = subaccountToHex({
            subaccountOwner: this.account.address,
            subaccountName: 'default'
        }) as `0x${string}`;

        const expiration = BigInt(Date.now() + 60000);
        const signature = await this.account.signTypedData({
            domain, types, primaryType: "StreamAuthentication",
            message: { sender, expiration }
        });

        this.ws?.send(JSON.stringify({
            method: "authenticate", id: 1,
            tx: { sender: sender, expiration: expiration.toString() },
            signature: signature
        }));
        await new Promise(r => setTimeout(r, 1000));
    }

    public async getPosition(symbol: string): Promise<Position | null> {
        // Not easily available in SDK without another request.
        // Returning null so StrategyEngine uses local tracking.
        return null;
    }


}
