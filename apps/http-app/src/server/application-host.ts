import { createApplicationRuntime } from '@itookit/app-core';
import { ApplicationHost } from '@itookit/app-core/application';
import { createPiAgentDriver } from '@itookit/piagent-driver';
import type { IStorageBackend } from '@itookit/vfs-core';
import { ApplicationApi } from './application-api';

/** The HTTP host owns the backend lifetime, including its storage-only API. */
function borrowBackend(backend: IStorageBackend): IStorageBackend {
    return new Proxy(backend, { get(target, key) {
        if (key === 'close') return async () => {};
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
}

export function createApplicationApi(backend: IStorageBackend): ApplicationApi {
    const host = new ApplicationHost(() => createApplicationRuntime({ backend: borrowBackend(backend),
        remoteSourceProvider: createPiAgentDriver(), ownerKind: 'cli', startupMode: 'interactive' }),
    ['minds', 'notes', 'anki', 'emails', 'private']);
    void host.start().catch(error => console.error('[Application] Host initialization failed', error));
    return new ApplicationApi(host);
}
