import { expect, it, vi } from 'vitest';
import { ConnectionManager } from '../../src/llm-management/device/connection-manager';
import type { LLMProvider } from '@itookit/driver-llm/contracts';

function fixture(document?: unknown) {
    let stored = document === undefined ? undefined : JSON.stringify(document);
    const write = vi.fn(async (_path: string, content: string) => { stored = content; });
    const fs = { driver: {
        resolvePath: vi.fn(async (path: string) => path.endsWith('.connection-settings.json') && stored !== undefined ? path : null),
        readContent: vi.fn(async () => stored), writeContent: write,
        createFile: vi.fn(async ({ content }: { content: string }) => { await write('settings', content); }), delete: vi.fn(),
    } };
    const provider: LLMProvider = { id: 'p', name: 'Provider', implementation: 'openai-compatible', apiKey: 'secret-value', media: {
        'image.generate': { adapter: 'openai-images' }, 'speech.synthesize': { adapter: 'openai-speech' },
    }, models: [{ id: 'chat', name: 'Chat' }, { id: 'image', name: 'Image', category: 'image', operations: {
        'image.generate': { inputModalities: ['text'], outputModalities: ['image'], formats: ['png'] },
    } }, { id: 'speech', name: 'Speech', category: 'audio', operations: {
        'speech.synthesize': { inputModalities: ['text'], outputModalities: ['audio'], formats: ['mp3'], voices: ['alloy'] },
    } }] };
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }, changed = vi.fn();
    const manager = new ConnectionManager({ getFileSystem: () => fs } as never, { removeDeviceNode: vi.fn() } as never,
        { getFullProviderMap: () => new Map([['p', provider]]) } as never, changed, undefined, undefined, undefined, logger);
    manager.setConnections(['chat', 'image', 'speech'].map(model => ({ id: model, name: model, providerId: 'p', tiers: { optimal: model } })));
    return { manager, provider, fs, write, logger, changed, document: () => stored && JSON.parse(stored) };
}

it('serializes independent purpose changes, reloads them and keeps the legacy API scoped to chat', async () => {
    const f = fixture(); await f.manager.loadSettings();
    await Promise.all([f.manager.setDefaultConnection('chat'), f.manager.setModelDefault('image.generate', 'image'), f.manager.setModelDefault('speech.synthesize', 'speech')]);
    expect(f.manager.getModelDefaults()).toEqual({ chat: 'chat', 'image.generate': 'image', 'speech.synthesize': 'speech' });
    expect(f.manager.getDefaultConnection()?.id).toBe('chat');
    expect(f.manager.getDefaultConnection('speech.synthesize')?.id).toBe('speech');
    await f.manager.setDefaultConnection(null); await f.manager.loadSettings();
    expect(f.document()).toEqual({ version: 1, defaults: { 'image.generate': 'image', 'speech.synthesize': 'speech' } });
    const copy = f.manager.getModelDefaults(); delete copy['image.generate']; expect(f.manager.getModelDefaults()['image.generate']).toBe('image');
});

it.each(['chat', 'image', 'missing'])('migrates only a compatible legacy chat default: %s', async id => {
    const f = fixture({ defaultConnectionId: id }); await f.manager.loadSettings();
    expect(f.manager.getModelDefaults()).toEqual(id === 'chat' ? { chat: 'chat' } : {});
    expect(f.write).not.toHaveBeenCalled();
});

it('rejects incompatible, unknown and disabled selections with actionable classification', async () => {
    const f = fixture();
    await expect(f.manager.setDefaultConnection('image')).rejects.toMatchObject({ code: 'MODEL_DEFAULT_CAPABILITY' });
    await expect(f.manager.setModelDefault('speech.synthesize', 'chat')).rejects.toThrow('speech.synthesize');
    await expect(f.manager.setModelDefault('chat', 'missing')).rejects.toMatchObject({ code: 'MODEL_DEFAULT_CONNECTION_MISSING' });
    await expect(f.manager.setModelDefault('unknown' as never, null)).rejects.toMatchObject({ code: 'MODEL_DEFAULT_INPUT' });
    f.provider.enabled = false;
    await expect(f.manager.setDefaultConnection('chat')).rejects.toMatchObject({ code: 'MODEL_DEFAULT_PROVIDER_DISABLED' });
    expect(f.write).not.toHaveBeenCalled(); expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('secret-value');
    expect(f.logger.warn).toHaveBeenLastCalledWith('model.defaults.failed', expect.objectContaining({ operationId: expect.any(Number), stage: 'validation', durationMs: expect.any(Number) }));
});

it('does not install failed writes and permits a later write without losing other purposes', async () => {
    const f = fixture(); await f.manager.setDefaultConnection('chat');
    f.write.mockRejectedValueOnce(new Error('storage offline'));
    await expect(f.manager.setModelDefault('image.generate', 'image')).rejects.toMatchObject({ code: 'MODEL_DEFAULT_SAVE_FAILED', message: 'storage offline' });
    expect(f.manager.getModelDefaults()).toEqual({ chat: 'chat' });
    await f.manager.setModelDefault('speech.synthesize', 'speech');
    expect(f.manager.getModelDefaults()).toEqual({ chat: 'chat', 'speech.synthesize': 'speech' });
    await f.manager.deleteConnection('speech');
    expect(f.manager.getModelDefaults()).toEqual({ chat: 'chat' });
});

it('propagates corrupt documents and read failures without replacing saved defaults', async () => {
    const f = fixture({ version: 99, defaults: { chat: 'chat' } });
    await expect(f.manager.loadSettings()).rejects.toThrow('Unsupported');
    expect(f.write).not.toHaveBeenCalled();
    f.fs.driver.readContent.mockRejectedValueOnce(new Error('read unavailable'));
    await expect(f.manager.loadSettings()).rejects.toThrow('read unavailable');
});

it('rejects a removed configured media tier instead of using the first catalog model', async () => {
    const f = fixture(); f.provider.models.reverse();
    f.manager.setConnections([{ id: 'invalid', name: 'Invalid', providerId: 'p', tiers: { optimal: 'removed' } }]);
    await expect(f.manager.setModelDefault('speech.synthesize', 'invalid')).rejects.toMatchObject({ code: 'MODEL_DEFAULT_CAPABILITY' });
    expect(f.manager.getModelDefaults()).toEqual({});
});

it('serializes connection deletion with default writes and rejects selecting a deleted connection', async () => {
    const f = fixture(); await f.manager.loadSettings();
    await Promise.all([f.manager.setModelDefault('speech.synthesize', 'speech'), f.manager.deleteConnection('speech')]);
    expect(f.manager.getModelDefaults()).toEqual({}); expect(f.document().defaults).toEqual({});
    expect(f.manager.getConnection('speech')).toBeUndefined();
    await expect(f.manager.setModelDefault('speech.synthesize', 'speech')).rejects.toMatchObject({ code: 'MODEL_DEFAULT_CONNECTION_MISSING' });
});

it('keeps the connection and its defaults after reference cleanup fails and resumes later mutations', async () => {
    const f = fixture(); await f.manager.setModelDefault('speech.synthesize', 'speech');
    f.write.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(f.manager.deleteConnection('speech')).rejects.toThrow('storage unavailable');
    expect(f.manager.getConnection('speech')).toBeDefined(); expect(f.manager.getModelDefaults()).toEqual({ 'speech.synthesize': 'speech' });
    expect(f.logger.warn).toHaveBeenLastCalledWith('connection.delete.failed', expect.objectContaining({ stage: 'defaults', code: 'CONNECTION_DELETE_FAILED' }));
    await f.manager.setModelDefault('chat', 'chat'); await f.manager.deleteConnection('speech');
    expect(f.manager.getModelDefaults()).toEqual({ chat: 'chat' });
});
