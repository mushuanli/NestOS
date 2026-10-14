import { expect, it, vi } from 'vitest';
import { FlowHistory } from '../src/session/flow-history';
import { roundToProjection } from '../src/persistence/round-log';
import { buildFlowChildren } from '../src/persistence/projection';

it('streams isolated tasks independently, hides logic, and preserves display after reload', async () => {
    const emitSession = vi.fn();
    const state = { updateNodeMeta: vi.fn(), appendToNode: vi.fn(), appendChildNode: vi.fn(), updateNodeOutput: vi.fn(), updateNodeStatus: vi.fn() };
    const history = new FlowHistory({ task: { sessionId: 's' }, rootNodeId: 'root', state } as never, { emitSession } as never);
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    function handle(id: string, kind = 'llm.agent') {
        const task = { id, program: { kind }, labels: { flowHistory: 'omit', dispatchKey: id }, createdAt: 1,
            status: 'succeeded', output: { message: { role: 'assistant', content: `${id} done` } } };
        return { status: async () => ({ task }), async *events() {
            yield { type: 'agent.event', payload: { type: 'llm:request', effectId: 'llm-exchange-1', connectionId: 'default', request: { messages: [{ role: 'user', content: id }] } } };
            yield { type: 'agent.event', payload: { type: 'stream:thinking', delta: `${id} thinking` } };
            yield { type: 'agent.event', payload: { type: 'stream:content', delta: `${id} partial` } };
            await gate;
        } };
    }
    const work = Promise.all([history.consume(handle('a') as never), history.consume(handle('b') as never), history.consume(handle('route', 'flow.dispatch') as never)]);
    await vi.waitFor(() => expect(emitSession.mock.calls.filter(([, e]) => e.type === 'message:updated' && e.payload.field === 'output')).toHaveLength(2));
    expect(emitSession.mock.calls.filter(([, e]) => e.type === 'message:updated' && e.payload.field === 'output').map(([, e]) => e.payload.messageId)).toEqual(['flow-a', 'flow-b']);
    expect(state.appendToNode.mock.calls).toEqual([['flow-a', 'a thinking', 'thought'], ['flow-b', 'b thinking', 'thought']]);
    finish(); await work;
    expect(history.interactions.map(item => item.taskId)).toEqual(['a', 'b']);
    expect(history.interactions.every(item => item.status === 'success' && item.content.includes('done'))).toBe(true);
    const round = { id: 'r', sessionId: 's', origin: 'user', input: [{ role: 'user', content: 'input' }],
        output: [{ role: 'assistant', content: 'final' }], status: 'completed', executions: [], historyParentIds: [], createdAt: 1,
        result: { assistantBlocks: [], toolResults: [], flowInteractions: history.interactions } };
    const projection = roundToProjection(JSON.parse(JSON.stringify(round)), 'r');
    expect(buildFlowChildren(projection).map(node => node.data.output)).toEqual(history.interactions.map(item => item.content));
    expect(buildFlowChildren(projection).map(node => node.data.thought)).toEqual(['a thinking', 'b thinking']);
    expect(buildFlowChildren(projection)[0].data.metaInfo?.requests[0].request.messages[0].content).toBe('a');
    expect(round.output).toHaveLength(1);
});

it('shows requests and responses as separate assistant/user interactions', async () => {
    const history = new FlowHistory({ task: { sessionId: 's' }, rootNodeId: 'root', state: {
        appendChildNode() {}, updateNodeOutput() {}, updateNodeStatus() {},
    } } as never, { emitSession() {} } as never);
    const task = { id: 'dispatch', program: { kind: 'flow.dispatch' }, createdAt: 1, status: 'succeeded',
        interactions: { missing: { response: { essay: 'new essay' } } } };
    await history.consume({ status: async () => ({ task }), async *events() {
        yield { type: 'task.interaction.requested', payload: { id: 'missing', kind: 'input', prompt: 'Essay?' } };
        yield { type: 'task.interaction.resolved', payload: { interactionId: 'missing' } };
    } } as never);
    expect(history.interactions.map(item => item.role)).toEqual(['assistant', 'user']);
    expect(history.interactions.map(item => item.content)).toEqual(['Essay?', '{\n  "essay": "new essay"\n}']);
});

it('retains failed tool identity and separates identical call IDs across tasks', async () => {
    const { projectTaskInteractions } = await import('../src/persistence/flow-run-projection');
    const task = { id: 'a', program: { kind: 'llm.agent' }, status: 'failed', createdAt: 1,
        labels: { flowNodeId: 'check', flowNodeName: 'Check' }, input: {}, interactions: {},
        state: { skillContexts: [{ skillId: 'review', tools: [{ toolId: 'lookup' }] }], messages: [
            { role: 'assistant', tool_calls: [{ id: 'call:1', function: { name: 'lookup', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call:1', content: 'failed' },
        ] } };
    const events = [{ occurredAt: 2, type: 'agent.event', payload: { type: 'tool:error',
        call: { toolId: 'call:1', name: 'lookup', input: {}, error: 'MCP unavailable' } } }];
    const first = projectTaskInteractions(task as never, events as never).find(item => item.actor?.kind === 'tool')!;
    const second = projectTaskInteractions({ ...task, id: 'b' } as never, events as never).find(item => item.actor?.kind === 'tool')!;
    expect(first).toMatchObject({ status: 'failed', content: 'MCP unavailable', actor: { skillIds: ['review'], nodeName: 'Check' } });
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toContain(':');
});

it('restores thinking from durable events or assistant messages without mixing it into output', async () => {
    const { projectTaskInteractions } = await import('../src/persistence/flow-run-projection');
    const task = { id: 'a', program: { kind: 'llm.agent' }, status: 'failed', createdAt: 1, interactions: {},
        state: { messages: [{ role: 'assistant', content: 'Answer', thinking: 'Saved thinking' }] } };
    const events = [{ type: 'agent.event', payload: { type: 'stream:thinking', delta: 'Partial thinking' } }];
    expect(projectTaskInteractions(task as never, events as never)[0]).toMatchObject({ content: 'Answer', thinking: 'Partial thinking', status: 'failed' });
    expect(projectTaskInteractions(task as never)[0]).toMatchObject({ content: 'Answer', thinking: 'Saved thinking' });
    expect(projectTaskInteractions({ ...task, state: {}, output: { message: { role: 'assistant', content: 'Final', thinking: 'Final thinking' } } } as never)[0])
        .toMatchObject({ content: '### result\n\nFinal', thinking: 'Final thinking' });
});

it('shows durable aggregate and judge events live and restores the same distinct round windows', async () => {
    const { projectTaskInteractions } = await import('../src/persistence/flow-run-projection');
    const state = { appendChildNode: vi.fn(), updateNodeOutput: vi.fn(), updateNodeStatus: vi.fn() };
    const history = new FlowHistory({ task: { sessionId: 's' }, rootNodeId: 'root', state } as never, { emitSession() {} } as never);
    const task = { id: 'route', program: { kind: 'flow.dispatch' }, status: 'succeeded', createdAt: 1, interactions: {} };
    const events = [1, 2].flatMap(round => ['aggregate', 'judge'].map(phase => ({
        type: 'flow.logic.completed', occurredAt: round * 10,
        payload: { nodeId: phase, name: phase, phase, round, result: phase === 'judge'
            ? { condition: { kind: 'literal', value: false }, matched: false, round, maxRounds: 2,
                stopReason: round === 2 ? 'max_rounds' : 'continue' } : { results: { language: { score: 8 } } } },
    })));
    await history.consume({ status: async () => ({ task }), async *events() { yield* events; yield events[3]; } } as never);
    expect(history.interactions).toHaveLength(4);
    expect(history.interactions.map(item => item.actor?.round)).toEqual([1, 1, 2, 2]);
    expect(history.interactions[1].content).toContain('"matched": false');
    expect(history.interactions[3].content).toContain('"stopReason": "max_rounds"');
    expect(history.interactions.every(item => !item.parallelGroup && item.status === 'success')).toBe(true);
    expect(projectTaskInteractions(task as never, events as never)).toEqual(history.interactions);
});

it('replaces failed stream fragments on retry both live and after recovery', async () => {
    const { projectTaskInteractions } = await import('../src/persistence/flow-run-projection');
    const state = { appendChildNode() {}, updateNodeOutput: vi.fn(), updateNodeThought: vi.fn(), updateNodeStatus() {}, updateNodeMeta() {} };
    const history = new FlowHistory({ task: { sessionId: 's' }, rootNodeId: 'root', state } as never, { emitSession() {} } as never);
    const task = { id: 'a', program: { kind: 'llm.agent' }, status: 'failed', createdAt: 1, interactions: {} };
    const request = { type: 'agent.event', payload: { type: 'llm:request', effectId: 'llm-exchange-1', connectionId: 'default', request: { messages: [] } } };
    const events = [request, { type: 'agent.event', payload: { type: 'stream:content', delta: 'BAD' } },
        { type: 'effect.retry.scheduled', payload: { effectId: 'llm-exchange-1', attempt: 2, maxAttempts: 4 } },
        request, { type: 'agent.event', payload: { type: 'stream:content', delta: 'GOOD' } }];
    await history.consume({ status: async () => ({ task }), async *events() { yield* events; } } as never);
    expect(history.interactions[0].content).toBe('GOOD');
    expect(state.updateNodeThought).toHaveBeenCalledWith('flow-a', '');
    expect(projectTaskInteractions(task as never, events as never)[0].content).toBe('GOOD');
});
