import { firstChatModelConnection } from '../../src/llm-management/presets';
import { expect, it, vi } from 'vitest';
import { ConnectionManager } from '../../src/llm-management/device/connection-manager';
import type { LLMProvider } from '@itookit/driver-llm/contracts';

it('creates one usable connection for an enabled Provider and preserves manual disables', async () => {
    const provider: LLMProvider = { id: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model' }], enabled: false };
    const changed = vi.fn(), engineUpsert = vi.fn().mockResolvedValue(undefined);
    const manager = new ConnectionManager({ engineUpsert } as never,
        { createDeviceNode: vi.fn().mockResolvedValue(undefined) } as never,
        { getFullProviderMap: () => new Map([['p', provider]]) } as never, changed, undefined, firstChatModelConnection);
    await manager.ensureProviderConnection(provider); expect(manager.getConnections()).toEqual([]);
    provider.enabled = true; await manager.ensureProviderConnection(provider);
    expect(manager.getConnections()).toMatchObject([{ providerId: 'p', enabled: true, model: 'm' }]);
    expect(engineUpsert).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledOnce();
    await manager.ensureProviderConnection(provider); expect(engineUpsert).toHaveBeenCalledOnce();
    const connection = manager.getRawConnections()[0];
    provider.enabled = false; expect(manager.getConnections()[0].enabled).toBe(false);
    provider.enabled = true; expect(manager.getConnections()[0].enabled).toBe(true);
    await manager.saveConnection({ ...connection, enabled: false });
    await manager.ensureProviderConnection(provider); expect(manager.getConnections()[0].enabled).toBe(false);
});
