/**
 * @file common/utils/utils.ts
 */

import { sha256Hex } from './digest';

/** Stable legacy fingerprint for identifiers; not a cryptographic content digest. */
export function simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

export function escapeHTML(str: string | null | undefined): string {
    if (!str) return '';
    const map: Record<string, string> = {
        '&': '&amp;', '<': '&lt;', '>': '&gt;',
        '"': '&quot;', "'": '&#39;'
    };
    return str.replace(/[&<>"']/g, tag => map[tag] || tag);
}

export function escapeAttr(str: string): string {
    return str.replace(/[&"']/g, (m) =>
        ({ '&': '&amp;', '"': '&quot;', "'": '&#39;' }[m] || m)
    );
}

export function generateUUID(): string {
    return 'node-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

/**
 * Generates a simplified, shorter UUID. Good enough for this context.
 * @returns {string} e.g., 'f4a2bcde'
 */
export function generateShortUUID(): string {
    return Math.random().toString(36).substring(2, 10);
}

export function generateId(prefix: string = 'item'): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function debounce<TArgs extends unknown[], TThis = unknown>(
    func: (this: TThis, ...args: TArgs) => unknown,
    delay: number,
): ((this: TThis, ...args: TArgs) => void) & { cancel: () => void } {
    let timeout: ReturnType<typeof setTimeout>;
    // 必须使用 function 关键字才能动态绑定 this
    const debounced = function (this: TThis, ...args: TArgs) {
        clearTimeout(timeout);
        // 捕获外部的 this
        const context = this;
        timeout = setTimeout(() => func.apply(context, args), delay);
    };
    debounced.cancel = () => clearTimeout(timeout);
    return debounced;
}

export function isClass(v: unknown): boolean {
    return typeof v === 'function' && /^\s*class\s+/.test(v.toString());
}

/**
 * 检查是否为图片类型
 */
export function isImageMimeType(mimeType: string): boolean {
    return mimeType.startsWith('image/');
}

/**
 * 延迟执行
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 节流
 */
export function throttle<TArgs extends unknown[]>(
    fn: (...args: TArgs) => unknown,
    limit: number
): (...args: TArgs) => void {
    let inThrottle = false;

    return (...args: TArgs) => {
        if (!inThrottle) {
            fn(...args);
            inThrottle = true;
            setTimeout(() => {
                inThrottle = false;
            }, limit);
        }
    };
}

/**
 * 重试
 */
export async function retry<T>(
    fn: () => Promise<T>,
    options: {
        maxAttempts?: number;
        delay?: number;
        backoff?: boolean;
        shouldRetry?: (error: unknown) => boolean;
    } = {}
): Promise<T> {
    const {
        maxAttempts = 3,
        delay = 1000,
        backoff = true,
        shouldRetry = () => true
    } = options;

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (attempt === maxAttempts || !shouldRetry(error)) {
                throw error;
            }

            const waitTime = backoff ? delay * Math.pow(2, attempt - 1) : delay;
            await sleep(waitTime);
        }
    }

    throw lastError;
}

/**
 * 超时包装
 */
export function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string = 'Operation timed out'
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(message));
        }, timeoutMs);

        promise
            .then(result => {
                clearTimeout(timeoutId);
                resolve(result);
            })
            .catch(error => {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

/**
 * 安全 JSON 解析
 */
export function safeJsonParse(str: string, fallback: unknown): unknown {
    try {
        return JSON.parse(str);
    } catch {
        return fallback;
    }
}

/**
 * 深度克隆
 */
export function deepClone<T>(obj: T): T {
    return structuredClone(obj);
}

/**
 * 截断字符串
 */
export function truncate(str: string, maxLength: number, suffix: string = '...'): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - suffix.length) + suffix;
}

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let size = bytes;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * 格式化持续时间
 */
export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

/**
 * 相对时间
 */
export function timeAgo(date: Date | number): string {
    const seconds = Math.floor((Date.now() - (typeof date === 'number' ? date : date.getTime())) / 1000);

    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;

    const d = typeof date === 'number' ? new Date(date) : date;
    return d.toLocaleDateString();
}


export async function calculateHash(buffer: ArrayBuffer): Promise<string> {
    return sha256Hex(buffer);
}

/**
 * Blob → Base64 (data URI prefix stripped).
 * Uses Blob.arrayBuffer() (universal: browser + Node 18+) instead of the
 * browser-only FileReader, so this stays type-safe when shared code is
 * typechecked in node-only contexts (device-tty / tools with lib:["ES2022"]).
 */
export async function blobToBase64(blob: Blob): Promise<string> {
    return arrayBufferToBase64(await blob.arrayBuffer());
}

/**
 * ArrayBuffer → Base64
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Base64 → ArrayBuffer
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

