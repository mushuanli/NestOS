import { expect, it, vi } from 'vitest';
import { isModelDefaults } from '@itookit/kernel-adapters/contracts';
import { validateAgentModelDefaults } from '../src/services/agent-model-defaults';

const provider = { id: 'p', name: 'Provider', implementation: 'openai-compatible', models: [{ id: 'chat', name: 'Chat' }] } as never;
const connection = { id: 'chat', name: 'Chat', providerId: 'p', model: 'chat' };
const catalog = () => ({ getConnection: vi.fn(async () => connection), getProvider: vi.fn(() => provider) });

it('keeps legacy Agents valid and rejects malformed or unsupported purpose declarations', async () => {
    const ports = catalog();
    await validateAgentModelDefaults(undefined, ports as never);
    expect(ports.getConnection).not.toHaveBeenCalled();
    for (const value of [null, [], { unknown: 'chat' }, { chat: '' }, { chat: 1 }]) {
        expect(isModelDefaults(value)).toBe(false);
        await expect(validateAgentModelDefaults(value as never, ports as never)).rejects.toMatchObject({ code: 'AGENT_MODEL_DEFAULT_INPUT' });
    }
});

it('validates existence, enabled state and model capability without requiring a credential probe', async () => {
    const ports = catalog();
    await expect(validateAgentModelDefaults({ chat: 'chat' }, ports as never)).resolves.toBeUndefined();
    await expect(validateAgentModelDefaults({ 'image.generate': 'chat' }, ports as never)).rejects.toMatchObject({ code: 'AGENT_MODEL_DEFAULT_CAPABILITY' });
    ports.getConnection.mockResolvedValueOnce(undefined as never);
    await expect(validateAgentModelDefaults({ chat: 'missing' }, ports as never)).rejects.toMatchObject({ code: 'AGENT_MODEL_DEFAULT_CONNECTION_MISSING' });
    ports.getConnection.mockResolvedValueOnce({ ...connection, enabled: false } as never);
    await expect(validateAgentModelDefaults({ chat: 'chat' }, ports as never)).rejects.toMatchObject({ code: 'AGENT_MODEL_DEFAULT_CONNECTION_DISABLED' });
});
