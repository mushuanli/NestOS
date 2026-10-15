import { createApplicationRuntime } from '@itookit/app-core';
import { createPiAgentDriver } from '@itookit/piagent-driver';
import type { IStorageBackend } from '@itookit/vfs-core';
import { guardHostStorage } from './host-storage';
import { ViewApi } from './view-api';
import type { AuditPort } from './audit-log';
import type { ProviderAuthorizationHost } from '@itookit/kernel-adapters/llm/core';

/** Storage and execution belong to the daemon; browser views borrow capabilities. */
export function createApplicationApi(backend: IStorageBackend, root?: string, audit?: AuditPort, providerAuthorization?: ProviderAuthorizationHost): ViewApi {
    const storage = root ? guardHostStorage(backend, root) : backend;
    const borrowed = new Proxy(storage, { get(target, key) {
        if (key === 'close') return async () => {};
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const ready = createApplicationRuntime({ backend: borrowed, remoteSourceProvider: createPiAgentDriver(), ownerKind: 'cli', startupMode: 'interactive', providerAuthorization });
    void ready.then(runtime => runtime.startBackground?.()).catch(error => console.error('[Application] Host initialization failed', error));
    return new ViewApi(ready, audit);
}
