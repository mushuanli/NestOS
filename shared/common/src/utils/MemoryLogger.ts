/**
 * @file common/utils/MemoryLogger.ts
 * @description 基于环形缓冲区的内存日志实现
 */

import {
    ILogger,
    LogLevel,
    LogEntry,
    LogFilter,
    LoggerStats,
    ModuleLog
} from '../interfaces/ILogger';

/** 默认缓冲区大小: 32KB */
const DEFAULT_MAX_SIZE = 32 * 1024;

/** 全局级别配置的特殊键 */
const GLOBAL_MODULE_KEY = '*';

/**
 * 内存日志实现
 * 
 * 特性:
 * - 32KB 环形缓冲区，自动淘汰旧日志
 * - 支持按模块设置日志级别
 * - 支持多维度过滤查询
 * 
 * @example
 * ```typescript
 * const logger = new MemoryLogger();
 * logger.setLevel('network', LogLevel.DEBUG);
 * logger.info('network', 'Request sent', { url: '/api/data' });
 * 
 * const errors = logger.query({ minLevel: LogLevel.ERROR });
 * ```
 */
export class MemoryLogger implements ILogger {
    private buffer: LogEntry[] = [];
    private currentSize: number = 0;
    private readonly maxSize: number;
    private readonly levelMap: Map<string, LogLevel> = new Map();
    private defaultLevel: LogLevel = LogLevel.INFO;

    constructor(maxSize: number = DEFAULT_MAX_SIZE) {
        this.maxSize = maxSize;
    }

    // ========== 核心日志方法 ==========

    log(module: string, level: LogLevel, message: string, data?: unknown): void {
        // 级别过滤
        if (!this.shouldLog(module, level)) {
            return;
        }

        const entry: LogEntry = {
            timestamp: Date.now(),
            module,
            level,
            message,
            data
        };

        const entrySize = this.estimateSize(entry);

        // 淘汰旧日志直到有足够空间
        while (this.buffer.length > 0 && this.currentSize + entrySize > this.maxSize) {
            this.evictOldest();
        }

        // 单条日志超过缓冲区大小时截断 message
        if (entrySize > this.maxSize) {
            const truncatedEntry = this.truncateEntry(entry, this.maxSize);
            this.buffer.push(truncatedEntry);
            this.currentSize += this.estimateSize(truncatedEntry);
        } else {
            this.buffer.push(entry);
            this.currentSize += entrySize;
        }
    }

    debug(module: string, message: string, data?: unknown): void {
        this.log(module, LogLevel.DEBUG, message, data);
    }

    info(module: string, message: string, data?: unknown): void {
        this.log(module, LogLevel.INFO, message, data);
    }

    warn(module: string, message: string, data?: unknown): void {
        this.log(module, LogLevel.WARN, message, data);
    }

    error(module: string, message: string, data?: unknown): void {
        this.log(module, LogLevel.ERROR, message, data);
    }

    // ========== 查询方法 ==========

    query(filter: LogFilter = {}): LogEntry[] {
        const { modules, minLevel, startTime, endTime, limit } = filter;
        const results: LogEntry[] = [];

        for (const entry of this.buffer) {
            // 模块过滤
            if (modules && modules.length > 0 && !modules.includes(entry.module)) {
                continue;
            }

            // 级别过滤
            if (minLevel !== undefined && entry.level < minLevel) {
                continue;
            }

            // 时间范围过滤
            if (startTime !== undefined && entry.timestamp < startTime) {
                continue;
            }
            if (endTime !== undefined && entry.timestamp > endTime) {
                continue;
            }

            // 返回副本防止外部修改
            results.push({ ...entry });

            // 数量限制
            if (limit !== undefined && results.length >= limit) {
                break;
            }
        }

        return results;
    }

    // ========== 级别控制 ==========

    setLevel(module: string, level: LogLevel): void {
        if (module === GLOBAL_MODULE_KEY) {
            this.defaultLevel = level;
        } else {
            this.levelMap.set(module, level);
        }
    }

    getLevel(module: string): LogLevel {
        if (module === GLOBAL_MODULE_KEY) {
            return this.defaultLevel;
        }
        return this.levelMap.get(module) ?? this.defaultLevel;
    }

    /**
     * 获取所有已配置的模块级别
     * @returns 模块名到级别的映射
     */
    getAllModuleLevels(): Map<string, LogLevel> {
        return new Map(this.levelMap);
    }

    /**
     * 移除模块的级别覆盖配置
     */
    removeModuleLevel(module: string): void {
        this.levelMap.delete(module);
    }

    // ========== 管理方法 ==========

    clear(): void {
        this.buffer = [];
        this.currentSize = 0;
    }

    getStats(): LoggerStats {
        return {
            totalEntries: this.buffer.length,
            bufferSize: this.currentSize,
            maxSize: this.maxSize,
            oldestTimestamp: this.buffer.length > 0 ? this.buffer[0].timestamp : null,
            newestTimestamp: this.buffer.length > 0 ? this.buffer[this.buffer.length - 1].timestamp : null
        };
    }

    // ========== 私有方法 ==========

    private shouldLog(module: string, level: LogLevel): boolean {
        const threshold = this.levelMap.get(module) ?? this.defaultLevel;
        return level >= threshold;
    }

    private estimateSize(entry: LogEntry): number {
        // 使用 JSON 序列化估算大小
        // 这是一个近似值，足够用于缓冲区管理
        try {
            return JSON.stringify(entry).length * 2; // UTF-16 字符
        } catch {
            // 如果序列化失败，使用保守估计
            return entry.message.length * 2 + 200;
        }
    }

    private evictOldest(): void {
        const oldest = this.buffer.shift();
        if (oldest) {
            this.currentSize -= this.estimateSize(oldest);
            // 防止浮点误差导致负数
            if (this.currentSize < 0) {
                this.currentSize = 0;
            }
        }
    }

    private truncateEntry(entry: LogEntry, maxSize: number): LogEntry {
        // 保留基本结构，截断 message
        const baseSize = this.estimateSize({ ...entry, message: '', data: undefined });
        const availableForMessage = Math.max(0, maxSize - baseSize - 100); // 留 100 字节余量
        const maxMessageLength = Math.floor(availableForMessage / 2);

        return {
            ...entry,
            message: entry.message.length > maxMessageLength
                ? entry.message.substring(0, maxMessageLength) + '...[truncated]'
                : entry.message,
            data: undefined // 超大日志丢弃 data
        };
    }
}

// ========== 单例管理 ==========

let globalLogger: MemoryLogger | null = null;

/**
 * 获取全局日志实例
 */
export function getLogger(): MemoryLogger {
    if (!globalLogger) {
        globalLogger = new MemoryLogger();
    }
    return globalLogger;
}

/**
 * 重置全局日志实例 (主要用于测试)
 */
export function resetLogger(): void {
    globalLogger = null;
}

/**
 * 创建独立的日志实例 (用于隔离场景)
 */
export function createLogger(maxSize?: number): MemoryLogger {
    return new MemoryLogger(maxSize);
}

/**
 * 创建模块级 Logger
 * 
 * @param module 模块名称（如 'llm-driver', 'vfs'）
 * @returns 绑定了模块名的日志方法
 * 
 * @example
 * ```typescript
 * // 在模块入口创建一次
 * export const log = createModuleLogger('llm-driver');
 * 
 * // 在模块内任意文件使用
 * import { log } from './logger';
 * log.info('Request sent', { model: 'gpt-4' });
 * ```
 */
export function createModuleLogger(module: string): ModuleLog {
    return {
        debug: (message: string, data?: unknown) => getLogger().debug(module, message, data),
        info: (message: string, data?: unknown) => getLogger().info(module, message, data),
        warn: (message: string, data?: unknown) => getLogger().warn(module, message, data),
        error: (message: string, data?: unknown) => getLogger().error(module, message, data),
    };
}