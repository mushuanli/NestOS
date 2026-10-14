import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import type { ILLMService } from '@itookit/driver-llm/contracts';
import { createApplicationRuntime, type ApplicationRuntime } from '../src/runtime/create-application-runtime';
import { OcrService } from '../src/configuration/ocr-service';

let runtime: ApplicationRuntime;
afterEach(async () => { vi.restoreAllMocks(); await runtime?.dispose(); });
async function setup() {
    runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web' });
    const agents = runtime.agentService, fs = await runtime.vfs.openFileSystem('/etc');
    await agents.saveProvider({ baseURL: '', id: 'vision', name: 'Vision', implementation: 'openai-compatible', apiKey: 'test',
        models: [{ id: 'image-model', name: 'Image', supportsVision: true }, { id: 'text-model', name: 'Text' }] });
    await agents.saveConnection({ id: 'ocr', name: 'OCR', providerId: 'vision', tiers: { optimal: 'image-model', fast: 'text-model' } });
    await agents.saveConnection({ id: 'chat', name: 'Chat', providerId: 'vision', tiers: { optimal: 'text-model' } });
    await agents.setDefaultConnection('chat');
    const chat = vi.fn<ILLMService['chat']>().mockResolvedValue({ choices: [{ message: { content: '# Recognized' } }] } as never);
    const service = new OcrService(fs, agents, { chat } as unknown as ILLMService); await service.init();
    return { service, agents, fs, chat };
}
it('starts unconfigured, persists explicit choices, and never uses the chat default', async () => {
    const { service, agents, fs, chat } = await setup();
    expect(service.snapshot().connectionId).toBeUndefined();
    await expect(service.recognize(new Blob())).rejects.toThrow(); expect(chat).not.toHaveBeenCalled();
    expect(await agents.getSystemPrompt(service.snapshot().systemPromptId)).toBeTruthy();
    await service.save({ ...service.snapshot(), connectionId: 'ocr' });
    const reopened = new OcrService(fs, agents, { chat } as unknown as ILLMService); await reopened.init();
    expect(reopened.snapshot()).toEqual(service.snapshot());
    expect(await reopened.recognize(new Blob(['image'], { type: 'image/png' }))).toBe('# Recognized');
    expect(chat.mock.calls[0][0]).toBe('ocr');
    expect(chat.mock.calls[0][1]).toMatchObject({ model: 'image-model', messages: [
        { role: 'system' }, { role: 'user', attachments: [{ type: 'image', mimeType: 'image/png' }] },
    ] });
    expect((await agents.getDefaultConnection())?.id).toBe('chat');
});
it('revalidates vision support, connection status and credentials before sending', async () => {
    const { service, agents, chat } = await setup();
    await expect(service.save({ ...service.snapshot(), connectionId: 'chat' })).rejects.toThrow();
    await service.save({ ...service.snapshot(), connectionId: 'ocr' });
    const conn = (await agents.getFullConnection('ocr'))!;
    await agents.saveConnection({ ...conn, enabled: false });
    expect(await service.ready()).toBe(false); await expect(service.recognize(new Blob())).rejects.toThrow();
    await agents.saveConnection({ ...conn, tiers: { optimal: 'text-model' } });
    await expect(service.recognize(new Blob())).rejects.toThrow();
    await agents.saveConnection(conn);
    await agents.saveProvider({ ...agents.getFullProvider('vision')!, apiKey: '' });
    await expect(service.recognize(new Blob())).rejects.toThrow(); expect(chat).not.toHaveBeenCalled();
});
it('resolves shared prompt edits for later requests and retains each submitted prompt', async () => {
    const { service, agents, chat } = await setup();
    await agents.saveSystemPrompt({ id: 'shared', name: 'Shared', content: ['First', 'Keep formulas'] });
    await service.save({ connectionId: 'ocr', systemPromptId: 'shared' });
    await service.recognize(new Blob());
    await agents.saveSystemPrompt({ id: 'shared', name: 'Shared', content: ['Edited'] });
    await service.recognize(new Blob());
    expect(chat.mock.calls[0][1].messages.slice(0, 2).map(m => m.content)).toEqual(['First', 'Keep formulas']);
    expect(chat.mock.calls[1][1].messages[0].content).toBe('Edited');
});
it('keeps deleted references explicit across restart instead of restoring or falling back', async () => {
    const { service, agents, fs, chat } = await setup();
    await service.save({ ...service.snapshot(), connectionId: 'ocr' });
    await agents.deleteConnection('ocr');
    await expect(service.recognize(new Blob())).rejects.toThrow();
    await agents.deleteSystemPrompt(service.snapshot().systemPromptId);
    const reopened = new OcrService(fs, agents, { chat } as unknown as ILLMService); await reopened.init();
    expect(reopened.snapshot()).toEqual(service.snapshot());
    expect(await agents.getSystemPrompt(service.snapshot().systemPromptId)).toBeNull();
    expect(await reopened.ready()).toBe(false); expect(chat).not.toHaveBeenCalled();
});
it('does not publish failed writes or alter the previous OCR selection', async () => {
    const { service, fs } = await setup(), listener = vi.fn();
    service.subscribe(listener);
    vi.spyOn(fs.driver, 'writeContent').mockRejectedValueOnce(new Error('disk failure'));
    await expect(service.save({ ...service.snapshot(), connectionId: 'ocr' })).rejects.toThrow('disk failure');
    expect(service.snapshot().connectionId).toBeUndefined(); expect(listener).not.toHaveBeenCalled();
    await service.save({ ...service.snapshot(), connectionId: 'ocr' });
    expect(listener).toHaveBeenCalledOnce();
});
it('accepts local Codex vision without an API key but rejects empty prompts', async () => {
    const { service, agents } = await setup();
    const codex = agents.getProvider('codex')!;
    await service.save({ ...service.snapshot(), connectionId: 'conn-codex' });
    expect(codex.models.some(m => m.supportsVision)).toBe(true);
    await agents.saveSystemPrompt({ id: 'empty', name: 'Empty', content: ['  '] });
    await expect(service.save({ connectionId: 'conn-codex', systemPromptId: 'empty' })).rejects.toThrow();
});
it.each([
    [{ fast: 'cheap-image', standard: 'image-model', optimal: 'image-model' }, 'cheap-image', 'fast'],
    [{ fast: 'text-model', standard: 'image-model', optimal: 'cheap-image' }, 'image-model', 'standard'],
    [{ fast: 'missing', standard: 'image-model' }, 'image-model', 'standard'],
    [{ optimal: 'image-model' }, 'image-model', 'optimal'],
    [{ fast: 'Cheap image', optimal: 'image-model' }, 'cheap-image', 'fast'],
] as const)('selects the lowest configured vision tier for %j', async (tiers, modelId, tier) => {
    const { service, agents, chat } = await setup();
    const provider = agents.getFullProvider('vision')!;
    await agents.saveProvider({ ...provider, models: [...provider.models, { id: 'cheap-image', name: 'Cheap image', supportsVision: true }] });
    await agents.saveConnection({ id: 'ocr', name: 'OCR', providerId: 'vision', tiers });
    expect((await service.connections()).find(item => item.connection.id === 'ocr')).toMatchObject({ available: true, modelId, tier });
    await service.save({ ...service.snapshot(), connectionId: 'ocr' }); await service.recognize(new Blob());
    expect(chat.mock.calls[0][1].model).toBe(modelId);
});
it('does not use unassigned provider models or the implicit first-model fallback', async () => {
    const { service, agents, chat } = await setup();
    for (const tiers of [undefined, { fast: 'missing' }, { optimal: 'text-model', fast: 'text-model' }]) {
        await agents.saveConnection({ id: 'ocr', name: 'OCR', providerId: 'vision', tiers });
        expect((await service.connections()).find(item => item.connection.id === 'ocr')?.available).toBe(false);
        await expect(service.save({ ...service.snapshot(), connectionId: 'ocr' })).rejects.toThrow();
    }
    expect(chat).not.toHaveBeenCalled();
});
it('reevaluates tier capabilities for each new recognition request', async () => {
    const { service, agents, chat } = await setup();
    await service.save({ ...service.snapshot(), connectionId: 'ocr' });
    await service.recognize(new Blob());
    const provider = agents.getFullProvider('vision')!;
    await agents.saveProvider({ ...provider, models: provider.models.map(model => ({ ...model, supportsVision: true })) });
    await service.recognize(new Blob());
    expect(chat.mock.calls.map(call => call[1].model)).toEqual(['image-model', 'text-model']);
});
it('edits the existing recognition prompt and only restores a deleted prompt on explicit editing', async () => {
    const { service, agents } = await setup();
    await service.save({ ...service.snapshot(), connectionId: 'ocr' });
    const id = service.snapshot().systemPromptId;
    await agents.saveSystemPrompt({ id, name: 'My OCR', content: ['Only tables'] });
    expect(await service.preparePromptEditor()).toBe(id);
    expect((await agents.getSystemPrompt(id))?.content).toEqual(['Only tables']);
    await agents.deleteSystemPrompt(id);
    expect(await service.ready()).toBe(false);
    expect(await agents.getSystemPrompt(id)).toBeNull();
    expect(await service.preparePromptEditor()).toBe(id);
    expect(await service.ready()).toBe(true);
});
