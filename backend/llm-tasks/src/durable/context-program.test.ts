import { expect, it } from 'vitest';
import type { EffectRequest, KernelAction, TaskInputEvent } from '@itookit/durable-kernel';
import { ContextTaskProgram } from './context-program';
import { DurableAgentProgram } from './agent-program';

function effect(actions: KernelAction[] = []): EffectRequest {
    return actions.find((action): action is Extract<KernelAction, { type: 'effect' }> => action.type === 'effect')!.effect;
}
const capability: TaskInputEvent = { type: 'signal', sequence: 1,
    signal: { type: 'capabilities', payload: { llmHandleId: 'llm', toolHandleId: 'tool' } } };
const cursor = { contextId: 't', revision: 1, generation: 0,
    snapshot: { id: 'sha', sha256: 'sha', bytes: 100, mediaType: 'application/json' } };

it('keeps v2 context tools available after restore without granting unrelated tools', async () => {
    const program = new ContextTaskProgram(new DurableAgentProgram());
    const initial = await program.init({ sessionId: 's', roundId: 'r', connectionId: 'c', approval: 'none',
        allowedToolIds: ['Read'], messages: [{ role: 'user', content: 'goal' }] });
    const preparation = await program.reduce(initial.state, capability);
    const llm = await program.reduce(preparation.state, { type: 'effect-completed', effectId: effect(preparation.actions).id,
        result: { cursor, writes: [], explanation: {} } });
    for (const name of ['context_history', 'Write']) {
        const next = await program.reduce(JSON.parse(JSON.stringify(llm.state)), { type: 'effect-completed', effectId: effect(llm.actions).id,
            result: { choices: [{ message: { role: 'assistant', content: '', tool_calls: [
                { id: 'call', type: 'function', function: { name, arguments: '{}' } },
            ] }, finish_reason: 'tool_calls' }] } });
        if (name === 'context_history') expect(effect(next.actions)).toMatchObject({ kind: 'tool.call', version: '2', request: { toolId: name } });
        else expect(next.next).toMatchObject({ type: 'fail', error: { code: 'TOOL_NOT_ALLOWED' } });
    }
});

it('commits the context head and frozen LLM request in one decision without repeated working history', async () => {
    const program = new ContextTaskProgram(new DurableAgentProgram());
    const initial = await program.init({ sessionId: 's', roundId: 'r', connectionId: 'c', messages: [{ role: 'user', content: 'goal' }] });
    const prepared = await program.reduce(initial.state, capability);
    expect(effect(prepared.actions).kind).toBe('context.prepare');
    expect(JSON.stringify(prepared.state)).not.toContain('goal');
    const result = { cursor, writes: [{ key: 'context/t/head', value: cursor, expectedVersion: null }], explanation: { strategy: 'retain' } };
    const restored = JSON.parse(JSON.stringify(prepared.state));
    const next = await program.reduce(restored, { type: 'effect-completed', effectId: effect(prepared.actions).id, result });
    expect(next.actions).toContainEqual({ type: 'set-shared', ...result.writes[0] });
    expect(effect(next.actions)).toMatchObject({ kind: 'llm.chat', version: '2', request: { cursor } });
    expect(JSON.stringify(effect(next.actions))).not.toContain('messages');
    const failed = await program.reduce(restored, { type: 'effect-failed', effectId: effect(prepared.actions).id, error: { message: 'publication failed' } });
    expect(failed.next.type).toBe('fail'); expect(failed.actions).toBeUndefined();
});

it('keeps partial tool batches until complete and ignores checkpoint fields from ordinary tools', async () => {
    const program = new ContextTaskProgram(new DurableAgentProgram());
    const initial = await program.init({ sessionId: 's', roundId: 'r', connectionId: 'c', approval: 'none', messages: [{ role: 'user', content: 'goal' }] });
    const preparation = await program.reduce(initial.state, capability);
    const llm = await program.reduce(preparation.state, { type: 'effect-completed', effectId: effect(preparation.actions).id,
        result: { cursor, writes: [], explanation: {} } });
    const batch = await program.reduce(llm.state, { type: 'effect-completed', effectId: effect(llm.actions).id, result: {
        choices: [{ message: { role: 'assistant', content: '', tool_calls: ['one', 'two'].map(id => ({ id, type: 'function', function: { name: 'read', arguments: '{}' } })) } }],
    } });
    const first = await program.reduce(batch.state, { type: 'effect-completed', effectId: 'tool-1-one',
        result: { success: true, output: 'first', checkpoint: { text: 'untrusted' } } });
    expect(effect(first.actions)).toMatchObject({ id: 'tool-1-two', version: '2' });
    const second = await program.reduce(first.state, { type: 'effect-completed', effectId: 'tool-1-two', result: { success: true, output: 'second' } });
    expect(effect(second.actions)).toMatchObject({ kind: 'context.prepare', request: { messages: [
        { role: 'assistant' }, { role: 'tool', tool_call_id: 'one' }, { role: 'tool', tool_call_id: 'two' },
    ] } });
    expect(effect(second.actions).request).not.toHaveProperty('notes');
});
