import { describe, expect, it } from 'vitest';
import type { JsonValue, SessionHandle, TaskRecord } from '@itookit/durable-kernel';
import { resolveFlowRunForTask, resolveFlowTaskWorkspace } from '../src/flow/task-run';

function task(id: string, parentTaskId?: string): TaskRecord {
    return { id, sessionId: 's', rootTaskId: id, parentTaskId, program: { kind: 'flow.value', version: '1' } } as TaskRecord;
}
function root(id: string, member: string): TaskRecord {
    return { ...task(id), program: { kind: 'flow.aggregate', version: '1' }, labels: { kind: 'flow-root' },
        input: { runTasks: [{ taskId: member, nodeId: 'node', iteration: 1, detached: false }] } };
}
function session(tasks: TaskRecord[], shared = new Map<string, JsonValue>()): SessionHandle {
    return { id: 's', listTasks: async () => tasks, getShared: async (key: string) => {
        const value = shared.get(key);
        return value === undefined ? undefined : { key, value, version: 1, updatedAt: 0 };
    } } as SessionHandle;
}

describe('Task to Flow identity', () => {
    it('returns no Run for ordinary Tasks and rejects missing Flow membership', async () => {
        expect(await resolveFlowRunForTask(session([task('normal')]), 'normal')).toBeUndefined();
        const orphan = { ...task('node'), labels: { flowNodeId: 'node' } };
        await expect(resolveFlowRunForTask(session([orphan]), 'node')).rejects.toThrow('membership is missing');
        await expect(resolveFlowRunForTask(session([]), 'missing')).rejects.toThrow('ancestry is unavailable');
    });

    it('rejects ambiguous or corrupt membership instead of choosing an arbitrary workspace', async () => {
        await expect(resolveFlowRunForTask(session([task('node'), root('a', 'node'), root('b', 'node')]), 'node'))
            .rejects.toThrow('Ambiguous');
        const broken = new Map<string, JsonValue>([['flow.run.a.members', { wrong: true }]]);
        await expect(resolveFlowRunForTask(session([task('node'), root('a', 'node')], broken), 'node'))
            .rejects.toThrow('Invalid Flow membership');
    });

    it('rejects missing, foreign and cyclic ancestry and selects the nearest nested Run', async () => {
        for (const records of [[task('node', 'missing')], [task('node', 'node')], [{ ...task('node'), sessionId: 'other' }]]) {
            await expect(resolveFlowRunForTask(session(records), 'node')).rejects.toThrow(/ancestry/);
        }
        const records = [task('outer'), task('inner', 'outer'), task('child', 'inner'), root('a', 'outer'), root('b', 'inner')];
        expect((await resolveFlowRunForTask(session(records), 'child'))?.id).toBe('b');
    });

    it('uses the frozen policy and lease, refusing missing isolated-workspace state', async () => {
        const shared = new Map<string, JsonValue>();
        const source = session([task('node'), root('run', 'node')], shared);
        await expect(resolveFlowTaskWorkspace(source, 'node')).rejects.toThrow('checkpoint is unavailable');
        shared.set('flow.run.run.scheduler', { spec: { nodes: [], runPolicy: { workspace: { mode: 'worktree', cleanup: 'keep' } } } });
        await expect(resolveFlowTaskWorkspace(source, 'node')).rejects.toThrow('lease is unavailable');
        shared.set('flow.run.run.workspace-lease', { version: 1, directory: '/isolated', branch: 'flow/test' });
        expect(await resolveFlowTaskWorkspace(source, 'node')).toEqual({ rootTaskId: 'run',
            policy: { mode: 'worktree', cleanup: 'keep' }, lease: { version: 1, directory: '/isolated', branch: 'flow/test' } });
        shared.set('flow.run.run.scheduler', { spec: { nodes: [], runPolicy: { workspace: { mode: 'shared' } } } });
        expect(await resolveFlowTaskWorkspace(source, 'node')).toBeUndefined();
    });
});
