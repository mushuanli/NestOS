import { createNodeRuntime } from '../runtime/application';
import type { IStorageBackend } from '@itookit/vfs-core';
import { ViewApi } from './view-api';
import type { AuditPort } from '../logging/audit-log';
import type { ProviderAuthorizationHost } from '@itookit/kernel-adapters/llm/core';

/** Storage and execution belong to the daemon; browser views borrow capabilities. */
export async function createApplicationApi(backend: IStorageBackend, root?: string, audit?: AuditPort, providerAuthorization?: ProviderAuthorizationHost): Promise<ViewApi> {
    const runtime = await createNodeRuntime(backend, root, {startupMode: 'server', ownerKind: 'httpd', providerAuthorization});
    return new ViewApi(Promise.resolve(runtime), audit);
}
