const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[LOG_LEVEL as LogLevel];
}

function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  debug: (message: string, ...args: unknown[]): void => {
    if (shouldLog('debug')) {
      console.error(`[${timestamp()}] DEBUG: ${message}`, ...args);
    }
  },
  info: (message: string, ...args: unknown[]): void => {
    if (shouldLog('info')) {
      console.error(`[${timestamp()}] INFO: ${message}`, ...args);
    }
  },
  warn: (message: string, ...args: unknown[]): void => {
    if (shouldLog('warn')) {
      console.error(`[${timestamp()}] WARN: ${message}`, ...args);
    }
  },
  error: (message: string, ...args: unknown[]): void => {
    if (shouldLog('error')) {
      console.error(`[${timestamp()}] ERROR: ${message}`, ...args);
    }
  },
};
