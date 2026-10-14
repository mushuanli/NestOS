import type { JsonValue } from '../../contracts';

export function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function json<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export function outcome(value: unknown) {
    return { outputs: { result: { outputName: 'result', type: 'json' as const, content: json(value) as JsonValue } } };
}

export function assertKey(key: string): void {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || ['constructor', 'prototype'].includes(key)) {
        throw new Error(`Invalid structured Flow key: ${key}`);
    }
}
