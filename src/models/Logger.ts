export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

/**
 * 日志记录器类
 * 提供统一的日志记录接口
 */
export class Logger {
    private static instance: Logger;
    private logLevel: LogLevel = LogLevel.INFO;

    private constructor() {}

    /**
     * 获取Logger实例
     */
    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    /**
     * 设置日志级别
     */
    public setLogLevel(level: LogLevel): void {
        this.logLevel = level;
    }

    /**
     * 记录调试信息
     */
    public debug(message: string, ...args: any[]): void {
        if (this.logLevel <= LogLevel.DEBUG) {
            console.log(`[DEBUG] ${message}`, ...args);
        }
    }

    /**
     * 记录一般信息
     */
    public info(message: string, ...args: any[]): void {
        if (this.logLevel <= LogLevel.INFO) {
            console.log(`[INFO] ${message}`, ...args);
        }
    }

    /**
     * 记录警告信息
     */
    public warn(message: string, ...args: any[]): void {
        if (this.logLevel <= LogLevel.WARN) {
            console.warn(`[WARN] ${message}`, ...args);
        }
    }

    /**
     * 记录错误信息
     */
    public error(message: string, ...args: any[]): void {
        if (this.logLevel <= LogLevel.ERROR) {
            console.error(`[ERROR] ${message}`, ...args);
        }
    }
} 