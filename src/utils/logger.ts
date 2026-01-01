import winston from 'winston';

const logFormat = winston.format.printf(({ level, message, timestamp }) => {
    return `${timestamp} [${level.toUpperCase()}]: ${message}`;
});

export const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY/MM/DD hh:mm:ss A' }),
        logFormat
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                logFormat
            )
        }),
        new winston.transports.File({
            filename: 'bot.log',
            level: 'debug',
            maxsize: 50 * 1024 * 1024, // 50MB per file
            maxFiles: 100,              // Keep last 100 files (~5GB total)
            tailable: true              // Keep bot.log as current
        }),
        new winston.transports.File({
            filename: 'error.log',
            level: 'error',
            maxsize: 10 * 1024 * 1024,  // 10MB per file
            maxFiles: 50                // Keep last 50 error logs (~500MB)
        })
    ]
});
