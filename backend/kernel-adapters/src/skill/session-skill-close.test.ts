import { expect, it, vi } from 'vitest';
import type { IDeviceDriver } from '@itookit/vfs-core';
import { createKernelAdaptersRuntime } from '../runtime/create-kernel-adapters-runtime';
import { createSessionSkillControls } from './session-skill-controls';

it.each(['session', 'runtime'] as const)('waits for a live Skill identity write before %s cleanup', async kind => {
    let releaseWrite!: () => void;
    const writing = new Promise<void>(resolve => { releaseWrite = resolve; });
    const events: string[] = [];
    const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver,
        fileContextForSession: async () => ({ cwd: '/', vfs: {
            readFile: async () => '', writeFile: async () => {}, listFiles: async () => [],
        }, release: async () => { events.push('files released'); } }),
    });
    const setShared = vi.fn(async () => { await writing; events.push('identity saved'); });
    const controls = createSessionSkillControls({ openSession: async () => ({
        getShared: async () => undefined, setShared,
    }) } as never, runtime.sessions);
    let load: Promise<unknown> | undefined, closing: Promise<void> | undefined;
    try {
        await runtime.skillCatalog.saveSkill({ id: 'review', name: 'Review', description: '', type: 'prompt',
            enabled: true, instructions: 'Review.', tools: [], triggerPatterns: [], autoLoad: false, priority: 50 });
        load = controls.load('s', 'review');
        await vi.waitFor(() => expect(setShared).toHaveBeenCalledOnce());
        const queued = controls.load('s', 'review');
        const refused = expect(queued).rejects.toThrow(/changed|closed/);
        closing = kind === 'session' ? runtime.disposeSession('s') : runtime.dispose();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(events).toEqual([]);
        await expect(runtime.sessions.get('s')).rejects.toThrow(/closing|closed/);
        releaseWrite();
        await load; await refused; await closing;
        expect(events).toEqual(['identity saved', 'files released']);
    } finally { releaseWrite(); await load?.catch(() => {}); await closing; await runtime.dispose(); }
});
