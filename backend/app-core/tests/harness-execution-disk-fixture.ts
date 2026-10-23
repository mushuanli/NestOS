import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EffectSessionState, JsonValue, SharedStateEntry } from '@itookit/durable-kernel';

/** A test-only, single-writer CAS port; reopening must read the atomic file rather than retained objects. */
export async function diskState(path: string): Promise<{ state: EffectSessionState; close(): void }> {
    await mkdir(dirname(path), { recursive: true });
    let closed = false;
    const read = async (): Promise<Record<string, SharedStateEntry>> => {
        if (closed) throw new Error('Test state port is closed');
        try { return JSON.parse(await readFile(path, 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
    };
    const state: EffectSessionState = {
        get: async <T extends JsonValue>(key: string) => (await read())[key] as SharedStateEntry<T> | undefined,
        set: async <T extends JsonValue>(key: string, value: T, expectedVersion?: number | null) => {
            const entries = await read(), prior = entries[key];
            if (expectedVersion !== undefined && (prior?.version ?? null) !== expectedVersion)
                throw Object.assign(new Error('CAS conflict'), { code: 'CONFLICT' });
            const entry = { key, value, version: (prior?.version ?? 0) + 1, updatedAt: Date.now() };
            entries[key] = entry;
            await writeFile(`${path}.tmp`, JSON.stringify(entries), { mode: 0o600 }); await rename(`${path}.tmp`, path);
            return structuredClone(entry);
        },
    };
    return { state, close: () => { closed = true; } };
}
