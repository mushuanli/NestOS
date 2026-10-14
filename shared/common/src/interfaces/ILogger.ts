/**
 * @file common/interfaces/ILogger.ts
 * @description 内存日志系统接口定义
 */

/** 日志级别枚举 */
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    SILENT = 4  // 用于完全禁用某模块日志
}

/** 日志级别名称映射 */
export const LogLevelNames: Readonly<Record<LogLevel, string>> = {
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.INFO]: 'INFO',
    [LogLevel.WARN]: 'WARN',
    [LogLevel.ERROR]: 'ERROR',
    [LogLevel.SILENT]: 'SILENT'
};

/** 单条日志记录 */
export interface LogEntry {
    /** 时间戳 (Unix ms) */
    timestamp: number;
    /** 模块名 */
    module: string;
    /** 日志级别 */
    level: LogLevel;
    /** 日志内容 */
    message: string;
    /** 可选的结构化数据 */
    data?: unknown;
}

/** 日志过滤条件 */
export interface LogFilter {
    /** 模块名过滤 (支持多个，OR 关系) */
    modules?: string[];
    /** 最低级别 (>=) */
    minLevel?: LogLevel;
    /** 时间范围起始 (Unix ms, >=) */
    startTime?: number;
    /** 时间范围结束 (Unix ms, <=) */
    endTime?: number;
    /** 最大返回条数 */
    limit?: number;
}

/** 缓冲区统计 */
export interface LoggerStats {
    totalEntries: number;
    bufferSize: number;
    maxSize: number;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
}

/** 日志系统接口 */
export interface ILogger {
    /**
     * 记录日志
     * @param module 模块名
     * @param level 日志级别
     * @param message 日志内容
     * @param data 可选的附加数据
     */
    log(module: string, level: LogLevel, message: string, data?: unknown): void;

    /** 便捷方法 */
    debug(module: string, message: string, data?: unknown): void;
    info(module: string, message: string, data?: unknown): void;
    warn(module: string, message: string, data?: unknown): void;
    error(module: string, message: string, data?: unknown): void;

    /**
     * 提取日志
     * @param filter 过滤条件
     * @returns 符合条件的日志数组 (按时间升序)
     */
    query(filter?: LogFilter): LogEntry[];

    /**
     * 设置模块日志级别
     * @param module 模块名 ('*' 表示全局默认)
     * @param level 最低记录级别
     */
    setLevel(module: string, level: LogLevel): void;

    /**
     * 获取模块当前日志级别
     */
    getLevel(module: string): LogLevel;

    /**
     * 清空所有日志
     */
    clear(): void;

    /**
     * 获取缓冲区统计信息
     */
    getStats(): LoggerStats;
}

/**
 * 模块级 Logger 接口
 */
export interface ModuleLog {
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
}

/*
export const log = createModuleLogger('llm-driver');

// 使用
import { log } from '../utils/logger';
log.info('Request sent', { model });

// 在设置界面中：
// 1. 查看缓冲区使用情况
// 2. 配置模块级别（如将 network 设为 DEBUG）
// 3. 过滤查看特定模块/级别的日志
// 4. 搜索日志内容
// 5. 清空日志缓冲区
*/
