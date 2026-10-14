import { expect, it, vi } from 'vitest';
import type { SessionHandle, TaskRecord } from '@itookit/durable-kernel';
import { waitForFlowRunTasks } from '../src/flow/run-members';

it('waits for detached members and descendants created while draining, without waiting for the aggregate', async () => {
    const member = { id: 'member', effects: {}, status: 'running' } as TaskRecord;
    const root = { id: 'root', effects: {}, status: 'running', program: { kind: 'flow.aggregate' }, labels: { kind: 'flow-root' },
        input: { runTasks: [{ taskId: 'member', nodeId: 'n', iteration: 1, detached: true }] } } as TaskRecord;
    const tasks = [root, member];
    let finishMember!: () => void, finishChild!: () => void;
    const memberDone = new Promise<void>(resolve => { finishMember = resolve; });
    const childDone = new Promise<void>(resolve => { finishChild = resolve; });
    const waits: string[] = [];
    const session = { listTasks: async () => tasks, getShared: async () => undefined,
        attachTask: async (id: string) => ({ status: async () => ({ task: tasks.find(task => task.id === id) }),
            wait: async () => { waits.push(id); await (id === 'member' ? memberDone : childDone); } }),
    } as unknown as SessionHandle;
    let drained = false;
    const pending = waitForFlowRunTasks(session, root.id).then(() => { drained = true; });
    await vi.waitFor(() => expect(waits).toEqual(['member']));
    expect(drained).toBe(false);
    const child = { id: 'child', effects: {}, status: 'running', parentTaskId: 'member' } as TaskRecord;
    tasks.push(child); member.status = 'succeeded'; finishMember();
    await vi.waitFor(() => expect(waits).toEqual(['member', 'child']));
    expect(drained).toBe(false);
    child.status = 'succeeded'; finishChild(); await pending;
    expect(drained).toBe(true);
});

it('refuses cleanup when a persisted member cannot be found', async () => {
    const root = { id: 'root', effects: {}, program: { kind: 'flow.aggregate' }, labels: { kind: 'flow-root' },
        input: { runTasks: [{ taskId: 'lost', nodeId: 'n', iteration: 1 }] } };
    const session = { listTasks: async () => [root], getShared: async () => undefined,
        attachTask: async () => ({ status: async () => ({ task: root }) }),
    } as unknown as SessionHandle;
    await expect(waitForFlowRunTasks(session, 'root')).rejects.toThrow('member is unavailable');
});

it('waits for terminal Effect cleanup and observes retries added during the wait', async () => {
    const member = { id: 'member', status: 'cancelled', effects: {
        e: { status: 'cancelled', cleanupPending: true },
    } } as unknown as TaskRecord;
    const root = { id: 'root', status: 'succeeded', effects: {}, program: { kind: 'flow.aggregate' },
        labels: { kind: 'flow-root' }, input: { runTasks: [{ taskId: 'member', nodeId: 'n', iteration: 1 }] },
    } as unknown as TaskRecord;
    const tasks = [root, member];
    const retries: unknown[] = [];
    let reads = 0;
    const session = {
        listTasks: async () => { reads++; return tasks; },
        getShared: async (key: string) => key.endsWith('.retries') ? { value: retries } : undefined,
        attachTask: async (id: string) => ({ status: async () => ({ task: tasks.find(task => task.id === id) }) }),
    } as unknown as SessionHandle;
    let drained = false;
    const pending = waitForFlowRunTasks(session, 'root').then(() => { drained = true; });
    try {
        await vi.waitFor(() => expect(reads).toBeGreaterThan(1));
        expect(drained).toBe(false);
        const retry = { ...member, id: 'retry', effects: { e: { ...member.effects.e } } } as TaskRecord;
        tasks.push(retry);
        retries.push({ taskId: 'retry', nodeId: 'n', iteration: 2 });
        member.effects.e.cleanupPending = false;
        const previous = reads;
        await vi.waitFor(() => expect(reads).toBeGreaterThan(previous));
        expect(drained).toBe(false);
        retry.effects.e.cleanupPending = false;
        await pending;
        expect(drained).toBe(true);
    } finally {
        for (const task of tasks) for (const effect of Object.values(task.effects)) effect.cleanupPending = false;
        await pending;
    }
});
