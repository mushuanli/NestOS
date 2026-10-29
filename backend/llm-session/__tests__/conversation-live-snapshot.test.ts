import {expect, it, vi} from 'vitest';
import {ConversationRunCoordinator} from '../src/session/conversation-run-coordinator';
import {SessionState} from '../src/session/session-state';
import type {ExecutionNode} from '../src/contracts';

it('publishes authoritative stream and tool snapshots before notifying observers', async () => {
    const state = new SessionState('session');
    const root: ExecutionNode = {id: 'assistant', executorType: 'agent', executorId: 'agent', name: 'Agent',
        status: 'running', startTime: 0, data: {output: ''}, children: []};
    state.addPendingAssistantMessage({id: root.id, role: 'assistant', timestamp: 0, executionRoot: root});
    const observations: Array<{type: string; root: ExecutionNode}> = [];
    const eventBus = {emitGlobal: vi.fn(), emitSession: (_id: string, event: {type: string}) => {
        observations.push({type: event.type, root: structuredClone(state.getSessions()[0].executionRoot!)});
    }};
    const coordinator = new ConversationRunCoordinator({eventBus} as never) as any;
    const execution = {state, rootNodeId: root.id, task: {sessionId: 'session'}};
    const events = [
        {type: 'stream:thinking', delta: 'Reason'}, {type: 'stream:content', delta: 'First'}, {type: 'stream:content', delta: ' second'},
        {type: 'tool:queued', call: {toolId: 'tool', name: 'Test'}},
        {type: 'tool:running', call: {toolId: 'tool', name: 'Test'}},
        {type: 'tool:success', call: {toolId: 'tool', name: 'Test', result: 'Result'}},
        {type: 'tool:error', call: {toolId: 'failed', name: 'Test', error: 'Denied'}},
    ];
    const handle = {async *events() {for (const payload of events) yield {type: 'agent.event', payload};}};
    await coordinator.consumeEvents(handle, execution, {output: false}, []);
    const updates = observations.filter(item => item.type === 'message:updated');
    expect(updates.map(item => item.root.data)).toMatchObject([{thought: 'Reason', output: ''}, {output: 'First'}, {output: 'First second'}]);
    expect(observations.find(item => item.type === 'tool:running')!.root.children[0].status).toBe('running');
    expect(observations.find(item => item.type === 'tool:success')!.root.children[0]).toMatchObject({status: 'success', data: {output: 'Result'}});
    expect(observations.find(item => item.type === 'tool:error')!.root.children[1]).toMatchObject({status: 'failed', data: {error: 'Denied'}});
});
