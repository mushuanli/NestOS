import type { IAgentConfigService } from '@itookit/kernel-adapters/contracts';
import type { ConnectionOption } from '../domain/types';
import { buildConnectionOptions } from './AgentProvider';

interface Entry {
    references: number;
    revision: number;
    value?: ConnectionOption[];
    pending?: Promise<ConnectionOption[]>;
    unsubscribe: () => void;
}

const caches = new WeakMap<IAgentConfigService, Entry>();

/** Share a candidate snapshot and in-flight reads across open Session editors. */
export function acquireConnectionOptions(service: IAgentConfigService): {
    read(): Promise<ConnectionOption[]>;
    dispose(): void;
} {
    let entry = caches.get(service);
    if (!entry) {
        const created: Entry = { references: 0, revision: 0, unsubscribe: () => {} };
        created.unsubscribe = service.onChange(() => { created.revision++; created.value = undefined; });
        caches.set(service, created); entry = created;
    }
    const cache = entry;
    cache.references++;
    let disposed = false;
    return {
        read: () => readOptions(service, cache),
        dispose: () => {
            if (disposed) return;
            disposed = true;
            if (--cache.references === 0) { cache.unsubscribe(); caches.delete(service); }
        },
    };
}

async function readOptions(service: IAgentConfigService, cache: Entry): Promise<ConnectionOption[]> {
    if (cache.value) return structuredClone(cache.value);
    if (!cache.pending) {
        cache.pending = reloadOptions(service, cache).finally(() => { cache.pending = undefined; });
    }
    return structuredClone(await cache.pending);
}

async function reloadOptions(service: IAgentConfigService, cache: Entry): Promise<ConnectionOption[]> {
    while (true) {
        const revision = cache.revision;
        const value = await buildConnectionOptions(service);
        if (revision !== cache.revision) continue;
        cache.value = value;
        return value;
    }
}
