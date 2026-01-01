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
        return this.safeExecute("GetPosition", async () => {
            if (!this.client) return null;

            const targetId = this.productMap.get(symbol) || 2;

            const summary = await this.client.subaccount.getSubaccountSummary({
                subaccountOwner: this.account.address,
                subaccountName: 'default'
            });

            const summaryAny = summary as any;

            // 중요: balances에 포지션(Perp)와 현물(Spot)이 섞여 있을 수 있음.
            // 이전 로그 분석 결과 BTC 포지션(ID 2)이 balances 안에 존재했음.
            const positions = summaryAny?.perpPositions || summaryAny?.positions || summaryAny?.balances || [];

            if (positions.length > 0) {
                // logger.info(`[Position Debug] Found ${positions.length} items in balances/positions`);
                // positions.forEach((p: any) => logger.info(`[Pos Item] ID: ${p.productId}, Amt: ${p.amount}`)); 
            }

            for (const pos of positions) {
                const posProductId = pos.productId || pos.product_id;

                // === Product ID 매칭 (필수) ===
                // balances에 USDC(ID 0) 등 다른 자산이 섞여 있으므로 ID 확인 필수
                if (posProductId == targetId) {
                    // amount: 양수 = Long, 음수 = Short
                    const rawAmount = pos.amount || pos.size || "0";
                    const amount = parseFloat(rawAmount) / 1e18;

                    // === Indexer API를 통한 정확한 평단가 계산 ===
                    let avgEntry = 0;
                    if (amount !== 0) {
                        try {
                            avgEntry = await this.getAverageEntryPrice(amount, Number(targetId));
                            logger.info(`[Position] Calculated Avg Entry from Indexer: $${avgEntry.toFixed(2)}`);
                        } catch (e) {
                            logger.warn(`[Position] Failed to calc entry from indexer, fallback: ${e}`);
                            // Fallback
                            const rawVQuote = pos.vQuoteBalance || pos.entryNotional || "0";
                            const vQuote = Math.abs(parseFloat(rawVQuote) / 1e18);
                            avgEntry = vQuote / Math.abs(amount);
                        }
                    }

                    logger.info(`[Position] Found: ${amount.toFixed(5)} BTC @ $${avgEntry.toFixed(1)}`);

                    return {
                        symbol: symbol,
                        size: amount,
                        entryPrice: avgEntry,
                        unrealizedPnl: 0,
                        leverage: config.LEVERAGE || 5
                    };
                }
            }

            return null;
        });
    }

    /**
     * Indexer API를 통해 최근 체결 내역을 조회하고 
     * 현재 포지션 크기만큼의 가중 평균 진입가를 계산합니다.
     */
    private async getAverageEntryPrice(currentSize: number, productId: number): Promise<number> {
        try {
            const subaccount = subaccountToHex({
                subaccountOwner: this.account.address,
                subaccountName: 'default'
            });

            // Indexer V1 Root endpoint
            const url = "https://archive.prod.nado.xyz/v1";
            // limit를 넉넉히 잡아서 포지션 시작점(0)을 찾을 확률 높임
            const payload = {
                matches: {
                    subaccounts: [subaccount],
                    product_ids: [productId], // 해당 마켓 필터링 (필수)
                    limit: 100
                }
            };

            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (res.status !== 200) {
                const errText = await res.text();
                throw new Error(`Indexer API Error ${res.status}: ${errText.slice(0, 100)}`);
            }

            const data = await res.json();
            if (!data.matches || !Array.isArray(data.matches)) {
                return 0;
            }

            let totalValue = 0;
            let totalSizeAccumulated = 0;

            const isLong = currentSize > 0;

            // [핵심 수정]
            // 거래소 평단가는 부분 익절(Close)을 해도 변하지 않음.
            // 따라서 "현재 잔량"만 역추적하는 게 아니라,
            // "포지션이 시작된 지점(Genesis)"까지의 "모든 진입(Open) 주문"을 합산해야 함.

            const entryMatches: { size: number, price: number }[] = [];

            for (const m of data.matches) {
                // 1. Post Balance 파싱
                let postBalance = 0;
                let foundBalance = false;
                try {
                    const perp = m.post_balance?.base?.perp;
                    if (perp) {
                        if (Array.isArray(perp)) {
                            const p = perp.find((x: any) => x.product_id == productId);
                            if (p?.balance?.amount) {
                                postBalance = parseFloat(p.balance.amount) / 1e18;
                                foundBalance = true;
                            }
                        } else if (perp.product_id == productId && perp.balance?.amount) {
                            postBalance = parseFloat(perp.balance.amount) / 1e18;
                            foundBalance = true;
                        }
                    }
                } catch (e) { }

                if (!foundBalance) continue; // 잔고 정보 없으면 스킵 (계산 불가)

                const baseFilled = parseFloat(m.base_filled) / 1e18; // Net Flow (Buy: +, Sell: -)
                const preBalance = postBalance - baseFilled; // 역산: 체결 전 잔고

                const isCurrentLong = currentSize > 0;
                const isPreLong = preBalance > 0.0000001;
                const isPreZero = Math.abs(preBalance) <= 0.0000001;
                const isPreSameSide = (isCurrentLong === isPreLong) && !isPreZero;

                // [Step Analysis]
                // Case 1: Pre가 같은 방향 (ex: Short -> 더 깊은 Short)
                // -> 순수 진입(Add). 이 Match 전체가 평단에 기여. 계속 과거 탐색.

                // Case 2: Pre가 0 (ex: 0 -> Short)
                // -> 순수 진입(Open). 이 Match 전체가 평단에 기여.
                // -> 단, 여기가 시작점이므로 루프 종료.

                // Case 3: Pre가 다른 방향 (ex: Long -> Short) (Reversal)
                // -> "청산 + 진입" 복합 주문.
                // -> 이 Match의 크기(baseFilled) 중, '청산'에 쓰인 건 날리고, 
                //    '진입'에 쓰인 부분(= postBalance)만 평단에 기여해야 함.
                // -> 여기가 시작점이므로 루프 종료.

                // Case 4: Pre가 다른 방향인데 Post도 다른 방향? (ex: Long -> 덜 Long)
                // -> 이건 진입이 아니라 "청산(Reduce)" 주문임. 평단 영향 X.
                // -> 우리 포지션 방향(isLong)과 baseFilled 방향 비교로 이미 필터링됨?
                //    Short 포지션이면 baseFilled는 음수(매도). 
                //    Long -> 덜 Long은 매도(음수). 방향 같음.
                //    하지만 결과가 여전히 Long이므로, 우리(Short) 입장에선 진입 내역이 아님.
                //    postBalance가 우리 방향과 다르면 skip 해야 함.

                const isPostSameSide = (postBalance > 0) === isCurrentLong;
                if (Math.abs(postBalance) > 0.0000001 && !isPostSameSide) {
                    // 현재 Short인데 과거 잔고가 Long이었다?
                    // 이는 우리가 찾는 '현재 포지션의 진입 내역'이 아님 (이미 청산된 과거 사이클).
                    // 찾던 사이클이 끝났으므로 종료.
                    break;
                }

                // 체크: 이 주문이 우리 포지션 방향으로의 '진입' 혹은 '전환' 액션인가?
                // Short 포지션이면 -> 매도(baseFilled < 0)여야 함.
                const isActionSameSide = (baseFilled > 0) === isCurrentLong;
                if (!isActionSameSide) {
                    // 반대 방향 주문(익절/손절)은 평단 영향 없음. Skip.
                    continue;
                }

                // === 합산 로직 ===
                let useSize = Math.abs(baseFilled);
                let shouldBreak = false;

                if (!isPreSameSide) {
                    // Reversal(Long->Short) 또는 Open(0->Short)
                    // 이 경우 실제 진입된 물량은 Match Size 전체가 아니라, 잔고에 남은 양(postBalance) 만큼임.
                    // (Open인 경우 postBalance == baseFilled 이므로 동일)
                    useSize = Math.abs(postBalance);
                    shouldBreak = true; // 시작점이므로 종료
                }

                if (useSize > 0.0000001) {
                    let price = 0;
                    if (m.order && m.order.priceX18 && BigInt(m.order.priceX18) > 0n) {
                        price = parseFloat(m.order.priceX18) / 1e18;
                    } else {
                        const quoteFilled = parseFloat(m.quote_filled) / 1e18;
                        if (baseFilled !== 0 && quoteFilled !== 0) {
                            price = Math.abs(quoteFilled / baseFilled); // 전체 평단
                        }
                    }
                    entryMatches.push({ size: useSize, price: price });
                }

                if (shouldBreak) break;
            }

            // 수집된 모든 진입 주문의 가중 평균 계산
            for (const entry of entryMatches) {
                totalValue += entry.price * entry.size;
                totalSizeAccumulated += entry.size;
            }

            if (totalSizeAccumulated === 0) return 0;
            return totalValue / totalSizeAccumulated;

        } catch (e) {
            logger.error(`[Indexer] Error calculating entry price: ${e}`);
            throw e;
        }
    }
}
