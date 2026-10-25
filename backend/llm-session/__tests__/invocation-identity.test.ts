import {afterEach, beforeEach, expect, it} from 'vitest';
import {Kernel} from '@itookit/durable-kernel';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import type {Round} from '../src/contracts';
import {newRerunInvocation} from '../src/session/invocation-identity';

let kernel: Kernel, manager: Awaited<ReturnType<typeof createVFS>>['manager'];
beforeEach(async () => {
    ({manager} = await createVFS({rootBackend: new MemoryBackend()}));
    const fs = await manager.openFileSystem('/test'); kernel = new Kernel({catalog: {fs}, pollMs: 0});
    kernel.registerStorageResolver({kind: 'test', resolve: async () => ({fs, rootPath: '/session'})});
    kernel.registerProgram({manifest: {kind: 'value', version: '1'}, init: input => ({state: null, next: {type: 'complete', output: input}}),
        reduce: () => {throw new Error('Already complete');}});
    await kernel.initialize(); await kernel.createSession({id: 's', storage: {kind: 'test', locator: null}});
});
afterEach(async () => {kernel.dispose(); await kernel.waitIdle(); await manager.dispose();});

async function source(identity?: string, start = true) {
    const session = await kernel.openSession('s');
    const task = await session.submit({program: {kind: 'value', version: '1'}, input: 'original',
        ...(identity ? {labels: {invocationId: identity}} : {}), deferStart: !start});
    if (start) await task.wait({timeoutMs: 2000});
    const round = {executions: [{taskId: task.id, role: 'primary', ...(identity ? {invocation: {invocationId: identity}} : {})}]} as Round;
    return {task, round};
}

it('creates a new call identity linked to a terminal execution without changing that Task', async () => {
    const {task, round} = await source('original'), before = (await task.status()).task;
    const next = await newRerunInvocation(kernel, 's', round);
    expect(next).toMatchObject({retryOfInvocationId: 'original', retryOfSessionId: 's'});
    expect(next.invocationId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect((await task.status()).task).toEqual(before); expect(await kernel.listSessionTasks('s')).toHaveLength(1);
});
it('refuses active or inconsistent execution references', async () => {
    const {round} = await source('original', false);
    await expect(newRerunInvocation(kernel, 's', round)).rejects.toMatchObject({code: 'INVOCATION_NOT_TERMINAL'});
    await expect(newRerunInvocation(kernel, 'foreign', round)).rejects.toMatchObject({code: 'INVOCATION_EXECUTION_CONFLICT'});
    round.executions[0].invocation = {invocationId: 'incorrect'};
    await expect(newRerunInvocation(kernel, 's', round)).rejects.toMatchObject({code: 'INVOCATION_EXECUTION_CONFLICT'});
});
it('preserves deterministic legacy provenance while minting different user reruns', async () => {
    const {task, round} = await source();
    const first = await newRerunInvocation(kernel, 's', round), second = await newRerunInvocation(kernel, 's', round);
    expect(first.retryOfInvocationId).toBe(`legacy-task:s:${encodeURIComponent(task.id)}`);
    expect(second.retryOfInvocationId).toBe(first.retryOfInvocationId); expect(second.invocationId).not.toBe(first.invocationId);
    expect(round.executions[0].invocation).toBeUndefined();
});
it('does not invent a source Invocation for a never-executed draft', async () => {
    const next = await newRerunInvocation(kernel, 's'); expect(next.retryOfInvocationId).toBeUndefined();
    expect(await kernel.listSessionTasks('s')).toEqual([]);
});
