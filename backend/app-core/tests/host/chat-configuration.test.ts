import {expect, it, vi} from 'vitest';
import {createChatConfigurationView} from '../../src/configuration/chat-configuration';

function fixture() {
    const listeners = new Set<() => void>();
    const provider = {id: 'provider', name: 'Provider', apiKey: 'private', models: [{id: 'model', name: 'Model'}]};
    const connection = {id: 'connection', name: 'Connection', providerId: 'provider', model: 'model', hasApiKey: true};
    const prompt = {id: 'prompt', instructions: 'private prompt body', presets: [{name: 'Preset', prompt: 'Question'}]};
    const service = {
        listAgents: () => [{id: 'agent', name: 'Agent', systemPrompt: 'private agent body',
            config: {systemPromptId: 'prompt', systemPrompt: 'private config body'}}],
        getConnections: vi.fn(async () => [connection]), getDefaultConnection: async () => connection,
        getProviders: () => [provider], getSystemPrompt: vi.fn(async () => prompt),
        onChange: (listener: () => void) => { listeners.add(listener); return () => {listeners.delete(listener);}; },
    };
    return {service, provider, connection, listeners, changed: () => {for (const listener of listeners) listener();}};
}

it('publishes safe aggregate metadata and follows host changes without sharing mutable storage objects', async () => {
    const f = fixture(), view = await createChatConfigurationView(f.service as never);
    try {
        const first = view.getConfigurationSnapshot(), changed = vi.fn();
        view.subscribe(changed);
        expect(first).toMatchObject({defaultConnectionId: 'connection', promptPresets: {prompt: [{name: 'Preset'}]}});
        expect(JSON.stringify(first)).not.toContain('private');
        f.connection.name = 'Updated'; f.changed();
        await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
        expect(view.getConfigurationSnapshot().connections[0].name).toBe('Updated');
        expect(first.connections[0].name).toBe('Connection');
        expect(f.listeners.size).toBe(1);
    } finally {await view.dispose();}
    expect(f.listeners.size).toBe(0);
});

it('does not publish a read invalidated while it was in flight and releases a failed initialization', async () => {
    const f = fixture(); let resolve!: (value: typeof f.connection[]) => void;
    f.service.getConnections.mockImplementationOnce(() => new Promise(done => {resolve = done;}));
    const opening = createChatConfigurationView(f.service as never);
    f.changed(); resolve([]);
    const view = await opening;
    expect(view.getConfigurationSnapshot().connections).toHaveLength(1);
    expect(f.service.getConnections).toHaveBeenCalledTimes(2); await view.dispose();
    f.service.getConnections.mockRejectedValueOnce(new Error('unavailable'));
    await expect(createChatConfigurationView(f.service as never)).rejects.toThrow('unavailable');
    expect(f.listeners.size).toBe(0);
});

it('does not lose a configuration change queued as the previous refresh completes', async () => {
    const f = fixture(), view = await createChatConfigurationView(f.service as never);
    let queued = false;
    view.subscribe(() => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {f.connection.name = 'Latest'; f.changed();});
    });
    f.connection.name = 'Intermediate'; f.changed();
    try {await vi.waitFor(() => expect(view.getConfigurationSnapshot().connections[0].name).toBe('Latest'));}
    finally {await view.dispose();}
});
