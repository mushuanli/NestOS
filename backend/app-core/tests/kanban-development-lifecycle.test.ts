import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import type {TaskRecord} from '@itookit/durable-kernel';
import type {KanbanDispatch, KanbanItem} from '@itookit/kanban/contracts';
import {KanbanAutomationJournal} from '../src/kanban/automation-journal';
import {UserEventService} from '../src/events/service';
import {developmentLifecycle} from '../src/presets/kanban-development-lifecycle';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close();});
const dispatch: KanbanDispatch = {id: 'attempt', itemId: 'item', itemRevision: 1, planId: 'plan', planRevision: 1,
    principal: {kind: 'service', id: 'worker'}, definitionDigest: 'a'.repeat(64), attempt: 1, fence: 'fence', preparedAt: 1, outcome: 'running', inputs: {}};
it('runs cancellation finalization independently and reconciles a lost response without resubmitting', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), journal = new KanbanAutomationJournal(fs); await journal.open();
    await journal.update('managed-agent:work-attempt', () => ({target: {kind: 'agent', id: 'work-attempt', version: '1', digest: 'a'.repeat(64)}}));
    await journal.update('development-workspace:attempt', () => ({policy: {prompts: {files: [{name: 'task.md', content: '## postload.cancelled\nSummarize only'}]}}}));
    const hookId = 'attempt-postload-cancelled';
    const calls = {prepareTaskCall: vi.fn(), submitPreparedTaskCall: vi.fn().mockRejectedValueOnce(new Error('Reply lost')),
        inspectTaskCallSubmission: vi.fn(async () => ({executionSessionId: 'hook-child', submission: {task: {sessionId: hookId, taskId: 'caller'}}})),
        list: vi.fn(async () => [{input: {request: {submission: {id: hookId}}}, callerState: {settled: true}, executionTree: {settled: true}}])};
    const events = await UserEventService.open(fs);
    let authorized = false;
    const options = {journal, events, authorize: async () => authorized, calls: calls as never, prepareSession: vi.fn(async (id: string) => id), kernel: {
        task: async () => ({id: 'caller', sessionId: hookId, version: 1, effects: {}, exit: {status: 'succeeded', output: {exit: {status: 'succeeded'}}}}) as unknown as TaskRecord}};
    const first = developmentLifecycle(options);
    const item = {id: 'item', title: 'Task'} as KanbanItem;
    await first.enqueue('board', dispatch, item, {outcome: 'cancelled'});
    await first.enqueue('board', dispatch, item, {outcome: 'cancelled'});
    expect(await first.settled('attempt', 'cancelled')).toBe(false);
    await first.scan(); expect(calls.submitPreparedTaskCall).not.toHaveBeenCalled();
    authorized = true;
    await first.scan(); await first.dispose();
    const second = developmentLifecycle(options); closes.push(() => second.dispose());
    await second.scan(); await second.scan();
    expect(calls.submitPreparedTaskCall).toHaveBeenCalledTimes(1);
    expect(calls.prepareTaskCall).toHaveBeenCalledTimes(1);
    const input = calls.submitPreparedTaskCall.mock.calls[0][0];
    expect(input.request.expectedSessionId).toBe(hookId);
    expect(input.request.source.text).toContain('postload.cancelled');
    expect(input.request.source.text).toContain('Do not implement, commit');
    expect(await second.settled('attempt', 'cancelled')).toBe(true);
    expect((await journal.get<{done: boolean}>('development-lifecycle:' + hookId))?.done).toBe(true);
    expect((await events.listNotifications()).items).toHaveLength(1);
    await journal.update('development-policy:analysis', () => ({prompts: {files: [{name: 'decision.md', content: '## postload.failed\nDecision recovery summary'}]}}));
    await second.enqueue('board', {...dispatch, id: 'analysis'}, item, {outcome: 'failed'}, 'decision',
        {kind: 'agent', id: 'planner', version: '1', digest: 'b'.repeat(64)});
    await second.scan();
    const last = calls.submitPreparedTaskCall.mock.calls.at(-1)![0];
    expect(last.request.expectedTarget.id).toBe('planner');
    expect(last.request.source.text).not.toContain('Decision recovery summary');
    expect(last.request.source.text).toContain('prompts/decision.md');
    await journal.update('development-policy:custom',()=>({prompts:{files:[
        {name:'task.md',content:'Custom base without status sections'},
        {name:'task-post.md',content:'Custom post body'},
        {name:'task-succ.md',content:'Custom success body'},
        {name:'task-clear.md',content:'Custom cleanup body'}]}}));
    await second.enqueue('board',{...dispatch,id:'custom'},item,{outcome:'succeeded'},'task',
        {kind:'agent',id:'worker',version:'1',digest:'c'.repeat(64)});
    await second.scan();
    const custom=calls.submitPreparedTaskCall.mock.calls.at(-1)![0].request.source.text;
    expect(custom).toContain('prompts/task-post.md, _nestos/kanban/prompts/task-succ.md, _nestos/kanban/prompts/task-clear.md');
    expect(custom).not.toContain('Custom post body');
});
