import { expect, it, vi } from 'vitest';
import { createFlowRevision } from '@itookit/llm-flow';
import type { FlowDraft } from '@itookit/llm-flow/contracts';
import type { TaskInput } from '../src/core/types';
import { prepareFlowAgentInput, frozenFlowResolver, type FlowAgentPorts } from '../src/session/flow-agent';
import { InstructionQueueStore } from '../src/persistence/instruction-queue-store';
import { editInstructionQueue } from '../src/session/instruction-queue-rules';
import type { SessionInstructionQueue } from '../src/contracts/instruction-queue';

function fixture() {
    const definition = createFlowRevision({ id: 'registered-flow', name: 'Registered', nodes: [], edges: [],
        parameters: [{ name: 'secret', type: 'string' }], draftVersion: 1, updatedAt: 0 } as FlowDraft, 1);
    const info = vi.fn(), warn = vi.fn(), loadRevision = vi.fn(async () => definition);
    const ports: FlowAgentPorts = { definitions: { loadRevision }, prepareConnections: async flow => flow,
        identityResolver: { resolveExact: async () => { throw new Error('No referenced agents'); },
            getSkills: async () => [], getSystemPrompt: async () => null },
        resolveAgent: async () => ({ id: 'a', name: 'A', type: 'agent', agentVersion: 'agent-v1', execution: {
            kind: 'flow', flowId: 'registered-flow', parameters: { secret: 'PRIVATE-DEFAULT' },
        } }), host: { logger: { info, warn } as never } };
    const input: TaskInput = { sessionId: 's', text: 'PRIVATE-PROMPT ${param.literal}', files: [], agentId: 'a',
        overrides: { flowParameters: { secret: 'PRIVATE-ARGUMENT' } } };
    return { definition, ports, input, info, warn, loadRevision };
}

it('records structural admission metadata without exposing prompt or parameter contents', async () => {
    const { ports, input, info, warn } = fixture();
    const prepared = await prepareFlowAgentInput(input, ports);
    expect(prepared.sendIntent?.execution).toMatchObject({ kind: 'flow', parameters: { secret: 'PRIVATE-ARGUMENT' } });
    expect(info).toHaveBeenCalledWith('Flow Agent admitted', expect.objectContaining({ operation: 'agent.flow',
        stage: 'admission', result: 'success', parameterCount: 1, elapsedMs: expect.any(Number) }));
    expect(warn).not.toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain('PRIVATE-');
    expect(input.sendIntent).toBeUndefined();
});

it('rejects an Agent wrapper around a local Flow but retains accepted immutable bindings', async () => {
    const f = fixture(), prepared = await prepareFlowAgentInput(f.input, f.ports);
    f.definition.exposure = 'local';
    await expect(prepareFlowAgentInput(f.input, f.ports)).rejects.toMatchObject({code: 'CALLABLE_LOCAL_ONLY'});
    expect(f.warn).toHaveBeenCalledWith('Flow Agent admission failed', expect.objectContaining({
        stage: 'definition', errorCode: 'CALLABLE_LOCAL_ONLY'}));
    expect(await prepareFlowAgentInput(prepared, f.ports)).toBe(prepared);
    expect(prepared.instructionFlowBinding!.definition.exposure).toBeUndefined();
});

it('classifies invalid arguments without exposing supplied values in diagnostics', async () => {
    const { ports, input, info, warn } = fixture();
    input.overrides!.flowParameters = { secret: 123 };
    await expect(prepareFlowAgentInput(input, ports)).rejects.toThrow('Parameter secret must be string');
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Flow Agent admission failed', expect.objectContaining({ stage: 'parameters',
        result: 'failure', errorCategory: 'invalid-parameters', errorCode: 'parameter-type', operationId: 's:a', elapsedMs: expect.any(Number) }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE-');
});

it('rejects missing Flow files before execution and classifies the actual admission stage', async () => {
    const { ports, input, warn } = fixture();
    ports.definitions.loadRevision = async () => null;
    await expect(prepareFlowAgentInput(input, ports)).rejects.toMatchObject({ code: 'AGENT_DISABLED' });
    expect(warn).toHaveBeenCalledWith('Flow Agent admission failed', expect.objectContaining({ stage: 'definition', errorCategory: 'flow-unavailable', errorCode: 'flow-unavailable' }));
});

it('rejects a stale parameter form signature before freezing or dispatching the Flow', async () => {
    const f = fixture();
    f.input.overrides!.flowExpectedSignature = {id: f.definition.id, revision: f.definition.revision, digest: 'stale-form'};
    await expect(prepareFlowAgentInput(f.input, f.ports)).rejects.toMatchObject({code: 'FLOW_INPUT_SIGNATURE_CHANGED'});
    expect(f.info).not.toHaveBeenCalled();
    expect(f.warn).toHaveBeenCalledWith('Flow Agent admission failed', expect.objectContaining({
        stage: 'parameters', errorCode: 'FLOW_INPUT_SIGNATURE_CHANGED'}));
    expect(JSON.stringify(f.warn.mock.calls)).not.toContain('PRIVATE-');
});

it('does not rebind accepted definitions or consult the source library during frozen resolution', async () => {
    const { ports, input, loadRevision } = fixture();
    const prepared = await prepareFlowAgentInput(input, ports), before = loadRevision.mock.calls.length;
    expect(await prepareFlowAgentInput(prepared, ports)).toBe(prepared);
    expect(await frozenFlowResolver(prepared, loadRevision)('missing-after-deletion')).toBeNull();
    expect(loadRevision).toHaveBeenCalledTimes(before);
});

it('rejects corrupted persisted Flow bindings instead of executing a different identity or altered definition', async () => {
    const { ports, input } = fixture(), prepared = await prepareFlowAgentInput(input, ports);
    const item = { id: 'request', text: input.text, files: [], agentId: input.agentId, state: 'pending', branch: 'main',
        createdAt: 1, sendIntent: prepared.sendIntent, flowBinding: prepared.instructionFlowBinding };
    const source = { schemaVersion: 1, sessionId: 's', revision: 1, paused: false, items: [item] };
    let saved = structuredClone(source);
    const store = new InstructionQueueStore({ inspectSession: async () => ({ getShared: async () => ({ value: saved, version: 1 }) }) } as never);
    expect((await store.read('s')).items).toHaveLength(1);
    const corrupt = [
        (value: typeof item) => { value.flowBinding!.definition.name = 'altered'; },
        (value: typeof item) => { value.flowBinding!.agent.id = 'another-agent'; },
        (value: typeof item) => { (value.sendIntent!.execution as { flowId: string }).flowId = 'another-flow'; },
        (value: typeof item) => { value.flowBinding!.dependencies = [null as never]; },
        (value: typeof item) => { delete (value.flowBinding as Partial<typeof value.flowBinding>)!.connections; },
        (value: typeof item) => { (value.flowBinding!.connections as Record<string, unknown>).apiKey = 'PRIVATE-KEY'; },
        (value: typeof item) => { value.flowBinding!.plan!.graph.maxNodes = 42; },
        (value: typeof item) => { value.flowBinding!.plan!.identities.prompts.push(['altered', { id: 'altered', name: 'Altered', content: [] }]); },
        (value: typeof item) => { (value.flowBinding!.plan as unknown as Record<string, unknown>).apiKey = 'PRIVATE-KEY'; },
    ];
    for (const change of corrupt) {
        saved = structuredClone(source); change(saved.items[0]);
        await expect(store.read('s')).rejects.toMatchObject({ code: 'QUEUE_STORAGE_INVALID', message: 'Invalid instruction queue storage' });
    }
    saved = structuredClone(source); delete saved.items[0].flowBinding!.plan;
    expect((await store.read('s')).items).toHaveLength(1);
});

it('does not merge accepted calls with different frozen Agent execution settings', async () => {
    const { ports, input } = fixture(), prepared = await prepareFlowAgentInput(input, ports);
    const item = { id: 'first', text: 'first', files: [], agentId: input.agentId, state: 'pending' as const,
        branch: 'main', createdAt: 1, sendIntent: prepared.sendIntent, flowBinding: prepared.instructionFlowBinding };
    const other = structuredClone({ ...item, id: 'second', text: 'second' });
    other.flowBinding!.agent.agentVersion = 'another-frozen-agent-version';
    const queue: SessionInstructionQueue = { sessionId: 's', revision: 1, paused: true, items: [item, other] };
    expect(() => editInstructionQueue(queue, { action: 'merge', ids: ['first', 'second'], expectedRevision: 1 }))
        .toThrow('Merged instructions must use the same branch, agent and execution settings');
});

it('keeps only the selected input-group source when Agent defaults contain the other source', async () => {
    const f = fixture();
    f.definition.parameters = [{name: 'body', type: 'string'}, {name: 'pages', type: 'json'}];
    f.definition.inputGroups = [{name: 'source', mode: 'oneOf', parameters: ['body', 'pages']}];
    f.ports.resolveAgent = async () => ({id: 'a', name: 'A', type: 'agent', execution: {kind: 'flow', flowId: 'registered-flow', parameters: {pages: ['Old default source']}}});
    f.input.overrides!.flowParameters = {body: 'Selected text'};
    const prepared = await prepareFlowAgentInput(f.input, f.ports);
    expect(prepared.sendIntent?.execution).toMatchObject({kind: 'flow', parameters: {body: 'Selected text'}});
    expect((prepared.sendIntent!.execution as {parameters: object}).parameters).not.toHaveProperty('pages');
});
