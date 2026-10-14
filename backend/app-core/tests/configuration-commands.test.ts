import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime, type ApplicationRuntime } from '../src/runtime/create-application-runtime';
import { ConfigurationMutationError, ModelConfigurationCommands } from '../src/configuration/model-commands';
import { ToolboxDrawers } from '../src/configuration/toolbox-drawers';

let runtime: ApplicationRuntime;
afterEach(async () => { vi.restoreAllMocks(); await runtime?.dispose(); });
async function setup() {
    runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web' });
    const store = runtime.agentService;
    await store.saveProvider({ baseURL: '', id: 'remove-me', name: 'Remove', implementation: 'openai-compatible', models: [] });
    await store.saveConnection({ id: 'linked', name: 'Linked', providerId: 'remove-me' });
    await store.saveAgent({ id: 'dependent', name: 'Dependent', type: 'agent', config: {} });
    return { store, commands: new ModelConfigurationCommands(store) };
}
it('rejects a stale dependency preview before writing any configuration', async () => {
    const { store, commands } = await setup(), impact = await commands.inspectProviderDeletion(['remove-me']);
    await store.saveConnection({ id: 'new-link', name: 'New link', providerId: 'remove-me' });
    await expect(commands.deleteProviders({ revision: impact.revision })).rejects.toMatchObject({ code: 'EBUSY' });
    expect(store.getFullProvider('remove-me')).toBeDefined();
    expect(await store.getFullConnection('linked')).toBeDefined();
});
it('deletes a provider and its connections, clears the default, and retains independent agents', async () => {
    const { store, commands } = await setup();
    await store.setDefaultConnection('linked');
    const impact = await commands.inspectProviderDeletion(['remove-me']);
    await commands.deleteProviders({ revision: impact.revision });
    expect(store.getFullProvider('remove-me')).toBeUndefined();
    expect(await store.getFullConnection('linked')).toBeNull();
    expect(await store.getDefaultConnection()).toBeNull();
    expect((await store.getAgents()).find(item => item.id === 'dependent')?.config).toEqual({});
});
it('reports completed steps when a later storage operation fails', async () => {
    const { store, commands } = await setup(), impact = await commands.inspectProviderDeletion(['remove-me']);
    vi.spyOn(store, 'deleteConnection').mockRejectedValueOnce(new Error('delete unavailable'));
    let failure: unknown;
    try { await commands.deleteProviders({ revision: impact.revision }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ConfigurationMutationError);
    expect(failure).toMatchObject({ completed: [] });
    expect((await store.getAgents()).find(item => item.id === 'dependent')?.config).toEqual({});
    expect(store.getFullProvider('remove-me')).toBeDefined();
});
it('groups resources without rendering and isolates snapshots from callers', async () => {
    await setup();
    const groups = new ToolboxDrawers(await runtime.vfs.openFileSystem('/etc')); await groups.init();
    groups.setCatalog([{ kind: 'skills', path: '/skills/a' }], []);
    await groups.assign([{ path: '/skills/a', name: 'Learning' }]);
    const group = groups.forPath('/skills/a')!;
    group.paths.length = 0; group.name = 'Mutated';
    expect(groups.forPath('/skills/a')?.name).toBe('Learning');
    await groups.remove(groups.forPath('/skills/a')!);
    expect(groups.forPath('/skills/a')?.id).toBe('/drawers/ungrouped-skills');
});


it('persists an explicit global default and never substitutes the first available connection', async () => {
    const { store } = await setup();
    expect(await store.getDefaultConnection()).toBeNull();
    await store.setDefaultConnection('linked');
    const fs = await runtime.vfs.openFileSystem('/etc');
    expect(JSON.parse(await fs.driver.readContent('/llm/.connection-settings.json', { encoding: 'utf-8' }))).toEqual({ defaultConnectionId: 'linked' });
    expect((await store.getDefaultConnection())?.id).toBe('linked');
    await expect(store.setDefaultConnection('missing')).rejects.toThrow();
    expect((await store.getDefaultConnection())?.id).toBe('linked');
    await store.setDefaultConnection(null);
    expect(await store.getDefaultConnection()).toBeNull();
    expect((await store.getConnections()).length).toBeGreaterThan(0);
});

it('seeds Agent prompt references and invalidates the library cache after VFS edits', async () => {
    const { store } = await setup();
    expect((await store.getAgentConfig('default'))?.config).toMatchObject({ systemPromptId: 'default' });
    await store.saveSystemPrompt({ id: 'shared', name: 'Shared', content: ['Before'] });
    expect((await store.getSystemPrompt('shared'))?.content).toEqual(['Before']);
    const fs = await runtime.vfs.openFileSystem('/home/admin/agents');
    await fs.driver.writeContent('/system-prompts/shared.sp', JSON.stringify({ id: 'shared', name: 'Shared', content: ['After'] }));
    await vi.waitFor(async () => expect((await store.getSystemPrompt('shared'))?.content).toEqual(['After']));
    await expect(store.saveSystemPrompt({ id: '../outside', name: 'Invalid', content: [] })).rejects.toThrow('Invalid system prompt id');
});


it('restores a missing built-in prompt only when explicitly restoring its Agent', async () => {
    const { store } = await setup();
    await store.deleteSystemPrompt('default');
    expect(await store.getSystemPrompt('default')).toBeNull();
    await store.restoreItem('agent', 'default');
    expect((await store.getSystemPrompt('default'))?.content.length).toBeGreaterThan(0);
    expect((await store.getAgentConfig('default'))?.config.systemPromptId).toBe('default');
});
