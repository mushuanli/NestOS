import { afterEach, expect, it } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { requireMediaCapabilities } from '@itookit/driver-llm/contracts';
import { createApplicationRuntime, type ApplicationRuntime } from '../src/runtime/create-application-runtime';
import { modelCapabilities } from '../src/configuration/model-capabilities';

let runtime: ApplicationRuntime | undefined;
afterEach(async () => { await runtime?.dispose(); });

it('lists native speech in system recovery and restores its endpoint, capabilities and connection while preserving credentials', async () => {
    runtime = await createApplicationRuntime({ backend: new MemoryBackend(), digitalTwinAutoStart: false });
    const service = runtime.agentService;
    expect(await service.getRestorableItems()).toContainEqual(expect.objectContaining({
        type: 'provider', id: 'doubao-speech', name: 'Doubao (豆包语音)',
    }));
    const original = (await service.getFullProvider('doubao-speech'))!;
    await service.saveProvider({ ...original, name: 'Edited speech', apiKey: 'fixture-secret', media: undefined });
    await service.restoreItem('provider', 'doubao-speech');
    const restored = (await service.getFullProvider('doubao-speech'))!;
    expect(restored.apiKey).toBe('fixture-secret');
    expect(restored.media?.['speech.synthesize']).toEqual({ adapter: 'doubao-speech', path: '/api/v3/tts/unidirectional', sampleRate: 24000 });
    expect(() => requireMediaCapabilities(restored, restored.models[0], 'speech.synthesize')).not.toThrow();
    expect(modelCapabilities(restored)).toContain('speech.synthesize');
    await service.deleteConnection('conn-doubao-speech');
    expect(await service.getRestorableItems()).toContainEqual(expect.objectContaining({ type: 'connection', id: 'conn-doubao-speech', status: 'missing' }));
    await service.restoreItem('connection', 'conn-doubao-speech');
    expect(await service.getFullConnection('conn-doubao-speech')).toMatchObject({ providerId: 'doubao-speech', tiers: { optimal: 'seed-tts-2.0' } });
});
