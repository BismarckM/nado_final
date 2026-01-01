import dotenv from "dotenv";
dotenv.config();

export const config = {
    // Wallet Keys
    NADO_PRIVATE_KEY: process.env.NADO_PRIVATE_KEY as string,
    HYENA_PRIVATE_KEY: process.env.HYENA_PRIVATE_KEY as string,

    // Environment
    IS_TESTNET: true, // Force Testnet

    // Nado Settings
    NADO_RPC_URL: "wss://rpc-qnd.inkonchain.com",
    NADO_CHAIN_ID: 57073,
    TARGET_SYMBOL_NADO: "BTC-PERP",

    // Safety
    ZOMBIE_ORDER_MS: 900000, // 15 minutes

    // Hyperliquid Settings (For Hedging & Data)
    HYENA_API_URL: "https://api.hyperliquid.xyz",
    TARGET_SYMBOL_HYENA: "BTC",
    HYENA_BUILDER_FEE: 0,
    HYENA_BUILDER_ADDRESS: "0x0000000000000000000000000000000000000000",
    LEVERAGE: 5,

    // Market Making Parameters (from Python Bot)
    ORDER_SIZE_USD: 1000,     // Adjusted to meet min order size ($100) with 0.1 ratio
    MAX_OPEN_ORDERS: 50,
    REPRICE_THRESHOLD: 30, // $30 Difference tolerance (Deadband)
    MIN_PROFIT_SPREAD: 0.0003, // 3bps = 왕복 수수료(2bps) + 마진(1bps)

    // Jitter Loop Settings (Anti-Sybil)
    JITTER_MIN_MS: 1500,     // 1.5s
    JITTER_MAX_MS: 4000,     // 4.0s

    // Grid Settings
    LONG_SPREADS: [0.0006, 0.0012, 0.002, 0.003, 0.004],
    SHORT_SPREADS: [0.0006, 0.0012, 0.002, 0.003, 0.004],
    ORDER_RATIOS: [0.5, 0.2, 0.1, 0.1, 0.1],

    // Inventory Management
    MAX_POSITION_USD: 6000,  // Adjusted for $1300 capital (approx 4.6x)
    INVENTORY_SKEW_MULTIPLIER: 1.5,

    // Volatility Settings (ATR from Hyperliquid)
    ATR_PERIOD: 14,
    ATR_INTERVAL: '5m',
    BASE_SPREAD: 0.001,
    VOL_MULTIPLIER_MIN: 0.5,
    VOL_MULTIPLIER_MAX: 2.0,

    // Hedging Settings (Optional)
    ENABLE_HEDGING: false,    // Disabled
    HEDGE_THRESHOLD_USD: 5000, // Trigger at $5000

    // Telegram Settings
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN as string,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID as string,

    // Circuit Breaker Settings
    CIRCUIT_BREAKER_THRESHOLD: 0.05,  // 5% drawdown triggers circuit breaker
    CIRCUIT_BREAKER_COOLDOWN_MS: 30 * 60 * 1000, // 30 minutes cooldown
};
