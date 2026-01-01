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
            level: 'debug'
        }),
        new winston.transports.File({
            filename: 'error.log',
            level: 'error'
        })
    ]
});
