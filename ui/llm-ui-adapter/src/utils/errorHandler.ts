// @file: llm-ui/utils/errorHandler.ts

import { Toast } from '@itookit/ui-common';

export type ErrorSeverity = 'silent' | 'warn' | 'toast' | 'render';

export interface ErrorHandlerOptions {
    /** 模块名（用于日志前缀） */
    module: string;
    /** 默认严重级别 */
    defaultSeverity?: ErrorSeverity;
    /** 错误渲染回调（severity='render' 时使用） */
    onRenderError?: (error: Error) => void;
    /** 加载状态清理回调 */
    onResetLoading?: () => void;
}

export interface ClassifiedError {
    userMessage: string;
    icon: string;
    isAuthError: boolean;
    isRateLimit: boolean;
}

export class ErrorHandler {
    constructor(private options: ErrorHandlerOptions) { }

    /**
     * 错误分类 — 将技术错误转为用户友好消息
     */
    static classifyError(error: Error): ClassifiedError {
        const msg = error.message || 'Unknown error';

        if (msg.includes('401') || msg.includes('API key') || msg.includes('apiKey')) {
            return {
                userMessage: 'Authentication failed. Please check your API key settings.',
                icon: '🔐',
                isAuthError: true,
                isRateLimit: false,
            };
        }

        if (msg.includes('429') || msg.includes('rate limit')) {
            return {
                userMessage: 'Rate limit exceeded. Please wait a moment and try again.',
                icon: '⏳',
                isAuthError: false,
                isRateLimit: true,
            };
        }

        if (msg.includes('Cannot send consecutive')) {
            return {
                userMessage: 'Please wait for the previous response to complete.',
                icon: '⚠️',
                isAuthError: false,
                isRateLimit: false,
            };
        }

        if (msg.includes('not found') || msg.includes('Node not found')) {
            return {
                userMessage: 'The requested resource was not found.',
                icon: '🔍',
                isAuthError: false,
                isRateLimit: false,
            };
        }

        return {
            userMessage: msg,
            icon: '❌',
            isAuthError: false,
            isRateLimit: false,
        };
    }

    /**
     * 统一处理错误
     */
    handle(error: unknown, context: string, severity?: ErrorSeverity): void {
        const err = error instanceof Error ? error : new Error(String(error));
        const level = severity ?? this.options.defaultSeverity ?? 'toast';
        const prefix = `[${this.options.module}]`;

        switch (level) {
            case 'silent':
                // Intentionally no output — caller handles the error silently
                break;

            case 'warn':
                console.warn(`${prefix} ${context}:`, err);
                break;

            case 'toast': {
                console.error(`${prefix} ${context}:`, err);
                const classified = ErrorHandler.classifyError(err);
                Toast.error(classified.userMessage);
                break;
            }

            case 'render': {
                console.error(`${prefix} ${context}:`, err);
                const classified = ErrorHandler.classifyError(err);
                if (classified.isAuthError) {
                    Toast.error(classified.userMessage);
                }
                this.options.onRenderError?.(err);
                break;
            }
        }

        this.options.onResetLoading?.();
    }

    /**
     * 包装异步操作，自动处理错误
     *
     * @returns 成功时返回结果，失败时返回 undefined
     */
    async wrap<T>(
        fn: () => Promise<T>,
        context: string,
        severity?: ErrorSeverity
    ): Promise<T | undefined> {
        try {
            return await fn();
        } catch (e) {
            this.handle(e, context, severity);
            return undefined;
        }
    }

    /**
     * 包装异步操作，失败时返回 fallback 值
     */
    async wrapWithFallback<T>(
        fn: () => Promise<T>,
        fallback: T,
        context: string,
        severity?: ErrorSeverity
    ): Promise<T> {
        try {
            return await fn();
        } catch (e) {
            this.handle(e, context, severity);
            return fallback;
        }
    }
}
