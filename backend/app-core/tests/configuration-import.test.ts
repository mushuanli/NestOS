import { describe, expect, it, vi } from 'vitest';
import type { IConnectionService } from '@itookit/kernel-adapters/contracts';
import type { LLMConfigFile } from '@itookit/kernel-adapters/llm/config';
import { executeImport, withConfigurationImport } from '../src/configuration/configuration-import';

const config: LLMConfigFile = {
    providers: [{ id: 'p', name: 'Provider', implementation: 'openai', baseURL: 'https://example.test', models: [] }],
    connections: [{ id: 'c', name: 'Connection', providerId: 'p' }],
    agents: [{ id: 'a', name: 'Agent', config: { connectionId: 'c' } }],
};
function fixture() {
    const writes: Array<{ kind: string; value: any }> = [];
    const service = {
        getProviders: () => [{ id: 'p' }], getFullProvider: () => ({ apiKey: 'saved-secret' }),
        getConnections: async () => [{ id: 'c' }], getAgents: async () => [{ id: 'a' }], getSkills: async () => [],
        saveProvider: vi.fn(async value => { writes.push({ kind: 'provider', value }); }),
        saveConnection: vi.fn(async value => { writes.push({ kind: 'connection', value }); }),
        saveAgent: vi.fn(async value => { writes.push({ kind: 'agent', value }); }), saveSkill: vi.fn(),
    } as unknown as IConnectionService;
    return { service, writes };
}
describe('backend configuration import', () => {
    it('previews conflicts without writes and keeps service methods bound to their owner', async () => {
        const { service, writes } = fixture();
        const port = withConfigurationImport(service);
        expect((await port.previewConfigurationImport(config)).map(item => item.type)).toEqual(['provider', 'connection', 'agent']);
        expect(writes).toEqual([]);
        expect(port.getProviders()).toEqual(service.getProviders());
    });
    it('allocates renamed identities and remaps the provider, connection and agent chain', async () => {
        const { service, writes } = fixture();
        const before = structuredClone(config);
        expect(await executeImport(config, service, 'rename')).toMatchObject({ providers: 1, connections: 1, agents: 1 });
        expect(writes.map(item => item.kind)).toEqual(['provider', 'connection', 'agent']);
        expect(writes[0].value.id).toBe('p-2');
        expect(writes[1].value).toMatchObject({ id: 'c-2', providerId: 'p-2' });
        expect(writes[2].value).toMatchObject({ id: 'a-2', config: { connectionId: 'c-2' } });
        expect(config).toEqual(before);
    });
    it('preserves stored credentials on overwrite and skips existing resources when requested', async () => {
        const overwritten = fixture();
        await executeImport(config, overwritten.service, 'overwrite');
        expect(overwritten.writes[0].value.apiKey).toBe('saved-secret');
        const skipped = fixture();
        expect(await executeImport(config, skipped.service, 'skip')).toMatchObject({ skipped: 3, providers: 0, connections: 0, agents: 0 });
        expect(skipped.writes).toEqual([]);
    });
    it('does not report success or continue to dependent writes after a save fails', async () => {
        const { service, writes } = fixture();
        vi.mocked(service.saveProvider).mockRejectedValueOnce(new Error('storage failed'));
        await expect(executeImport(config, service, 'overwrite')).rejects.toThrow('storage failed');
        expect(writes).toEqual([]);
    });
});
