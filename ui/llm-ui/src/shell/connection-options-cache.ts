import type { ChatConfigurationView, IAgentConfigService } from '@itookit/kernel-adapters/contracts';
import type { ConnectionOption } from '../domain/types';
import { buildConnectionOptions } from './AgentProvider';

interface Entry {
    references: number;
    revision: number;
    value?: ConnectionOption[];
    pending?: Promise<ConnectionOption[]>;
    unsubscribe: () => void;
    configuration?: ChatConfigurationView;
    listeners: Set<() => void>;
}

const caches = new WeakMap<object, Entry>();

interface ConnectionOptionsHandle {
    read(): Promise<ConnectionOption[]>;
    subscribe(listener: () => void): () => void;
    dispose(): void;
}

/** Share a candidate snapshot and in-flight reads across open Session editors. */
export function acquireConnectionOptions(service: IAgentConfigService, configuration?: ChatConfigurationView): ConnectionOptionsHandle {
    const key = configuration ?? service;
    let entry = caches.get(key);
    if (!entry) {
        entry = createEntry(service, configuration);
        caches.set(key, entry);
    }
    return acquireHandle(service, key, entry);
}

function createEntry(service: IAgentConfigService, configuration?: ChatConfigurationView): Entry {
    const cache: Entry = { references: 0, revision: 0, unsubscribe: () => {}, configuration, listeners: new Set() };
    const changed = () => {
        cache.revision++; cache.value = undefined;
        for (const listener of cache.listeners) {
            try { listener(); } catch { /* Keep independent selectors observable. */ }
        }
    };
    cache.unsubscribe = configuration ? configuration.subscribe(changed) : service.onChange(changed);
    return cache;
}

function acquireHandle(service: IAgentConfigService, key: object, cache: Entry): ConnectionOptionsHandle {
    cache.references++;
    const listeners = new Set<() => void>();
    let disposed = false;
    return {
        read: () => readOptions(service, cache),
        subscribe: listener => {
            if (disposed) return () => {};
            const owned = () => { if (!disposed && listeners.has(owned)) listener(); };
            listeners.add(owned); cache.listeners.add(owned);
            return () => { listeners.delete(owned); cache.listeners.delete(owned); };
        },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            for (const listener of listeners) cache.listeners.delete(listener);
            listeners.clear();
            if (--cache.references === 0) { cache.unsubscribe(); caches.delete(key); }
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
        const value = await buildConnectionOptions(service, cache.configuration?.getConfigurationSnapshot());
        if (revision !== cache.revision) continue;
        cache.value = value;
        return value;
    }
}
