import { StrategyEngine } from "./modules/StrategyEngine.js";
import { logger } from "./utils/logger.js";

const engine = new StrategyEngine();

async function main() {
    logger.info("🚀 Starting Nado Grid Bot (Hybrid Mode)...");
    try {
        await engine.start();
    } catch (e) {
        logger.error(`Critical Error: ${e}`);
        process.exit(1);
    }
}

// Global Error Handlers
process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception: ${err}`);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection: ${reason}`);
});

main();
