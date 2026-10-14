import { describe, expect, it } from 'vitest';
import type { SkillDefinition } from '@itookit/tools/contracts';
import { Kernel, type DurableTaskProgram } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { createSkillTaskSpec } from './skill-task';

describe('createSkillTaskSpec', () => {
    it('compiles a multi-step Skill to a deferred Durable Task', () => {
        const spec = createSkillTaskSpec(skill({ kind: 'skill.review', version: '2' }), {
            path: 'src/index.ts',
        }, { priority: 4, labels: { source: 'command' } });

        expect(spec).toEqual({
            program: { kind: 'skill.review', version: '2' },
            input: { skillId: 'review', arguments: { path: 'src/index.ts' } },
            retry: undefined,
            priority: 4,
            labels: { source: 'command', skillId: 'review' },
            deferStart: true,
        });
    });

    it('rejects a Skill without a registered TaskProgram contract', () => {
        expect(() => createSkillTaskSpec(skill(), null)).toThrow('does not declare a valid TaskProgram');
    });

    it('runs the compiled Skill as a real Durable Task', async () => {
        const { manager } = await createVFS({
            rootBackend: new MemoryBackend(),
        });
        const fs = await manager.openFileSystem('/data/test');
        const kernel = new Kernel({ catalog: { fs } });
        try {
            kernel.registerStorageResolver({
                kind: 'test', resolve: async () => ({ fs, rootPath: '/skill/.kernel' }),
            });
            kernel.registerProgram(skillProgram());
            await kernel.initialize();
            const session = await kernel.createSession({ id: 'skill-session', storage: { kind: 'test', locator: null } });
            const spec = createSkillTaskSpec(skill({ kind: 'skill.review', version: '2' }), { path: 'a.ts' });
            const task = await session.submit(spec);
            expect((await task.status()).task.status).toBe('created');
            await task.start();
            await expect(task.wait({ timeoutMs: 2_000 })).resolves.toMatchObject({ output: 'a.ts' });
        } finally {
            kernel.dispose();
            await manager.dispose();
        }
    });
});

function skill(taskProgram?: SkillDefinition['taskProgram']): SkillDefinition {
    return {
        id: 'review', name: 'Review', description: 'Review code', type: 'prompt',
        enabled: true, instructions: 'Review carefully.', tools: [], triggerPatterns: [],
        autoLoad: false, priority: 0, taskProgram,
    };
}

function skillProgram(): DurableTaskProgram<null, { arguments: { path: string } }, string> {
    return {
        manifest: { kind: 'skill.review', version: '2' },
        init: input => ({ state: null, next: { type: 'complete', output: input.arguments.path } }),
        reduce: state => ({ state, next: { type: 'fail', error: { message: 'Unexpected event' } } }),
    };
}
