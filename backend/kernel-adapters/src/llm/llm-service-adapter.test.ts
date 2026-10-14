import { describe, expect, it, vi } from 'vitest';
import type { IDeviceDriver } from '@itookit/vfs-core';
import { LLMServiceAdapter } from './llm-service-adapter';

describe('LLMServiceAdapter lifecycle', () => {
    it('closes the device session when a synchronous request fails', async () => {
        const close = vi.fn(async () => undefined);
        const driver = {
            open: async () => 'llm-session',
            ioctl: async () => { throw new Error('provider failed'); },
            close,
        } as IDeviceDriver;
        const service = new LLMServiceAdapter(driver);

        await expect(service.chat('connection', { messages: [] })).rejects.toThrow('provider failed');

        expect(close).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'llm-session' }));
    });

    it('forwards attachments unchanged so the selected provider owns their encoding', async () => {
        const request = { messages: [{ role: 'user' as const, content: 'inspect',
            attachments: [{ type: 'image' as const, source: '/workspace/image.png' }] }] };
        const ioctl = vi.fn(async (_context: unknown, _command: unknown, _request: unknown) => ({ choices: [] }));
        const service = new LLMServiceAdapter({ open: async () => 's', ioctl, close: async () => {} } as IDeviceDriver);
        await service.chat('codex', request);
        expect(ioctl.mock.calls[0][2]).toBe(request);
        expect(request.messages[0].attachments[0].source).toBe('/workspace/image.png');
    });

    it('closes a streaming session when its consumer stops early', async () => {
        const close = vi.fn(async () => undefined);
        const driver = {
            open: async () => 'llm-session',
            ioctl: async () => chunks(),
            close,
        } as IDeviceDriver;
        const service = new LLMServiceAdapter(driver);

        for await (const _chunk of service.chatStream('connection', { messages: [] })) break;

        expect(close).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'llm-session' }));
    });
});

async function* chunks() {
    yield { choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] };
    yield { choices: [{ index: 0, delta: { content: 'b' }, finish_reason: 'stop' as const }] };
}
