import type { JsonValue, SessionHandle, SharedStateEntry } from '@itookit/durable-kernel';
import type { SessionRuntime } from '../core/types';
import type { ConversationManifest, ISessionRepository } from './types';

const MANIFEST_KEY = 'conversation/manifest';
export const RUNTIME_KEY = 'conversation/runtime';

export class DurableConversationProjection {
    private readonly tails = new Map<string, Promise<void>>();

    constructor(private readonly engine: ISessionRepository) {}

    /** `manifest` lets a caller that just read it (a bind) skip re-reading the Session record. */
    sync(handle: SessionHandle, sessionId: string, runtime?: SessionRuntime,
        manifest?: ConversationManifest): Promise<void> {
        const previous = this.tails.get(handle.id) ?? Promise.resolve();
        const current = previous.catch(() => {}).then(() => this.syncNow(handle, sessionId, runtime, manifest));
        this.tails.set(handle.id, current);
        return current.finally(() => {
            if (this.tails.get(handle.id) === current) this.tails.delete(handle.id);
        });
    }

    private async syncNow(handle: SessionHandle, sessionId: string, runtime?: SessionRuntime,
        loaded?: ConversationManifest): Promise<void> {
        const manifest = loaded ?? await this.engine.getManifest(sessionId);
        // One snapshot for both keys: each getShared otherwise opens its own transaction, and the
        // sync runs per settle during a bind.
        const current = await readShared(handle, runtime ? [MANIFEST_KEY, RUNTIME_KEY] : [MANIFEST_KEY]);
        await syncValue(handle, MANIFEST_KEY, manifest as unknown as JsonValue, current[MANIFEST_KEY]);
        if (runtime) await syncValue(handle, RUNTIME_KEY, runtimeValue(runtime), current[RUNTIME_KEY]);
    }
}

/** Reads the requested keys together when the handle offers a batched read. */
async function readShared(handle: SessionHandle, keys: string[]): Promise<Record<string, SharedStateEntry | undefined>> {
    if (handle.getSharedMany) return await handle.getSharedMany(keys);
    const entries: Record<string, SharedStateEntry | undefined> = {};
    for (const key of keys) entries[key] = await handle.getShared(key);
    return entries;
}

async function syncValue(handle: SessionHandle, key: string, input: JsonValue,
    current?: SharedStateEntry): Promise<void> {
        const value = JSON.parse(JSON.stringify(input)) as JsonValue;
        if (JSON.stringify(current?.value) === JSON.stringify(value)) return;
        await handle.setShared(key, value, { expectedVersion: current?.version ?? null });
}

function runtimeValue(runtime: SessionRuntime): JsonValue {
    return {
        sessionId: runtime.sessionId,
        status: runtime.status,
        unreadCount: runtime.unreadCount,
        lastActiveTime: runtime.lastActiveTime,
    };
}
