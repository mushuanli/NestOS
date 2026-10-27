// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '@itookit/kernel-adapters/contracts';
import { bindAgentExecution, readAgentExecution, renderAgentExecution, type AgentExecutionController } from '../src/editors/agent-execution';
import type { AgentExecutionOptions, AgentFlowChoice, AgentFlowRevision } from '../src/editors/agent-execution-options';

const controllers: AgentExecutionController[] = [];
beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { controllers.splice(0).forEach(controller => controller.destroy()); document.body.replaceChildren(); vi.restoreAllMocks(); });

function mount(flows: AgentFlowChoice[], options: AgentExecutionOptions = {}, revision?: number, flowId = 'a') {
    const root = document.createElement('div'); document.body.append(root);
    const agent = { id: 'agent', name: 'Reader', type: 'agent', config: {},
        execution: { kind: 'flow', flowId, revision } } as AgentDefinition;
    root.innerHTML = renderAgentExecution(agent, flows);
    const controller = bindAgentExecution(root, agent, flows, options); controllers.push(controller);
    const change = (name: string, value: string) => {
        const field = root.querySelector<HTMLSelectElement>(`[name="${name}"]`)!;
        field.value = value; field.dispatchEvent(new Event('change', { bubbles: true }));
    };
    return { root, controller, change, read: () => readAgentExecution(root),
        parameter: (name: string) => root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-agent-flow-parameters] [name="agentFlowParameter:${name}"]`) };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

it('uses published schemas for latest and pinned revisions instead of the mutable draft schema', async () => {
    const revisions: AgentFlowRevision[] = [
        { revision: 1, parameters: [{ name: 'first', type: 'string' }] },
        { revision: 2, parameters: [{ name: 'latest', type: 'number' }] },
    ];
    const f = mount([{ id: 'a', name: 'Flow A', parameters: [{ name: 'unpublished', type: 'json' }] }], {
        listFlowRevisions: async () => revisions, getFlowRevision: async () => revisions[1],
    });
    await f.controller.ready();
    expect(f.parameter('latest')).not.toBeNull(); expect(f.parameter('unpublished')).toBeNull();
    f.change('executionRevision', '1'); await f.controller.ready();
    expect(f.parameter('first')).not.toBeNull(); expect(f.parameter('latest')).toBeNull();
    expect(f.read()).toMatchObject({ kind: 'flow', flowId: 'a', revision: 1 });
});

it('rejects a published local Flow as an Agent implementation even when its mutable draft is global', async () => {
    const f = mount([{id: 'a', name: 'Public draft'}], {
        getFlowRevision: async () => ({revision: 1, exposure: 'local'}),
        listFlowRevisions: async () => [{revision: 1, exposure: 'local'}],
    });
    await f.controller.ready();
    expect(f.root.querySelector('[data-agent-execution]')?.getAttribute('data-state')).toBe('error');
    expect(() => f.read()).toThrow();
});

it('restores each Flow pinned revision when their revision option sets differ', async () => {
    const revisions = (id: string): AgentFlowRevision[] => id === 'a'
        ? [{ revision: 1, parameters: [{ name: 'a1', type: 'string' }] }, { revision: 3, parameters: [{ name: 'a3', type: 'string' }] }]
        : [{ revision: 2, parameters: [{ name: 'b2', type: 'string' }] }];
    const f = mount([{ id: 'a', name: 'Flow A' }, { id: 'b', name: 'Flow B' }], {
        listFlowRevisions: async id => revisions(id), getFlowRevision: async id => revisions(id).at(-1)!,
    }, 1);
    await f.controller.ready(); expect(f.parameter('a1')).not.toBeNull();
    f.change('executionFlowId', 'b'); await f.controller.ready();
    f.change('executionRevision', '2'); await f.controller.ready();
    f.change('executionFlowId', 'a'); await f.controller.ready();
    expect(f.read()).toMatchObject({ flowId: 'a', revision: 1 });
    expect(f.parameter('a1')).not.toBeNull(); expect(f.parameter('a3')).toBeNull();
});

it('blocks saving a missing Flow or pinned version and retains the unavailable selection', async () => {
    const missing = mount([], {}, undefined, 'removed'); await missing.controller.ready();
    expect(() => missing.read()).toThrow();
    expect(missing.root.querySelector<HTMLSelectElement>('[name="executionFlowId"]')!.value).toBe('removed');
    const version = mount([{ id: 'a', name: 'Flow A' }], {
        listFlowRevisions: async () => [{ revision: 1 }], getFlowRevision: async () => ({ revision: 1 }),
    }, 7);
    await version.controller.ready();
    expect(() => version.read()).toThrow('7');
    expect(version.root.querySelector<HTMLSelectElement>('[name="executionRevision"]')!.value).toBe('7');
    expect(version.root.querySelector('[data-agent-flow-status]')!.getAttribute('role')).toBe('alert');
});

it('ignores a late response after a faster Flow selection has rendered', async () => {
    const first = deferred<AgentFlowRevision>(), second = deferred<AgentFlowRevision>();
    const f = mount([{ id: 'a', name: 'Flow A' }, { id: 'b', name: 'Flow B' }], {
        getFlowRevision: id => id === 'a' ? first.promise : second.promise,
    });
    f.change('executionFlowId', 'b');
    second.resolve({ revision: 2, parameters: [{ name: 'current', type: 'string' }] }); await f.controller.ready();
    expect(f.parameter('current')).not.toBeNull();
    first.resolve({ revision: 1, parameters: [{ name: 'stale', type: 'string' }] });
    await vi.waitFor(() => expect(f.root.querySelector('[data-agent-execution]')!.getAttribute('aria-busy')).toBe('false'));
    expect(f.read()).toMatchObject({ flowId: 'b' }); expect(f.parameter('stale')).toBeNull();
});

it('keeps an invalid JSON draft DOM when moving between versions and permits correction', async () => {
    const schema = [{ name: 'data', label: 'Data', type: 'json' as const }];
    const f = mount([{ id: 'a', name: 'Flow A' }], {
        listFlowRevisions: async () => [{ revision: 1, parameters: schema }], getFlowRevision: async () => ({ revision: 1, parameters: schema }),
    });
    await f.controller.ready(); const original = f.parameter('data')!; original.value = '{';
    f.change('executionRevision', '1'); await f.controller.ready();
    f.change('executionRevision', ''); await f.controller.ready();
    expect(f.parameter('data')).toBe(original); expect(original.value).toBe('{'); expect(f.read).toThrow('Data');
    original.value = '{"kept":false}'; expect(f.read()).toMatchObject({ parameters: { data: { kept: false } } });
});

it('does not render after disposal or include parameter content in configuration diagnostics', async () => {
    const pending = deferred<AgentFlowRevision>(), secret = 'PRIVATE_PARAMETER_SENTINEL';
    const f = mount([{ id: 'a', name: 'Flow A' }], { getFlowRevision: () => pending.promise });
    const before = f.root.innerHTML; f.controller.destroy();
    pending.resolve({ revision: 1, parameters: [{ name: 'secret', type: 'string', default: secret }] });
    await f.controller.ready(); expect(f.root.innerHTML).toBe(before);
    const loaded = mount([{ id: 'a', name: 'Flow A' }], {
        getFlowRevision: async () => ({ revision: 1, parameters: [{ name: 'secret', type: 'string', default: secret }] }),
    });
    await loaded.controller.ready(); expect(console.info).toHaveBeenCalled();
    const failed = mount([{ id: 'a', name: 'Flow A' }], { getFlowRevision: async () => { throw new Error(secret); } });
    await failed.controller.ready(); expect(console.error).toHaveBeenCalled();
    const messages = JSON.stringify([vi.mocked(console.info).mock.calls, vi.mocked(console.error).mock.calls]);
    expect(messages).not.toContain(secret);
});

it('stops waiting for an obsolete Flow read when switching back to an ordinary Agent', async () => {
    const pending = deferred<AgentFlowRevision>();
    const f = mount([{ id: 'a', name: 'Flow A' }], { getFlowRevision: () => pending.promise });
    f.change('executionKind', 'agent');
    let ready = false;
    void f.controller.ready().then(() => { ready = true; });
    await Promise.resolve(); await Promise.resolve();
    try {
        expect(ready).toBe(true);
        expect(f.read()).toEqual({ kind: 'agent' });
    } finally {
        pending.resolve({ revision: 1 }); await f.controller.ready();
    }
});

it('correlates the exact failing read with Agent, Flow, revision and safe remote error fields', async () => {
    const secret = 'PRIVATE_PARAMETER_ERROR_TEXT';
    const f = mount([{id: 'a', name: 'Private display label'}], {getFlowRevision: async () => {
        throw Object.assign(new Error(secret), {code: 'ECAPABILITY', remoteCode: 'RPC_CAPABILITY_RETIRED', requestId: 'request-123', outcome: 'unknown'});
    }}, 3);
    await f.controller.ready();
    const rows = vi.mocked(console.error).mock.calls;
    const read = rows.find(([event]) => event === 'agent.flow.configuration.read.failed')![1] as any;
    const summary = rows.find(([event]) => event === 'agent.flow.configuration.failed')![1] as any;
    expect(read).toMatchObject({agentId: 'agent', flowId: 'a', requestedRevision: 3, stage: 'definition', code: 'FLOW_DEFINITION_READ_FAILED',
        causeCode: 'ECAPABILITY', remoteCode: 'RPC_CAPABILITY_RETIRED', requestId: 'request-123', outcome: 'unknown'});
    expect(summary).toMatchObject({operationId: read.operationId, stage: 'definition', code: 'FLOW_DEFINITION_READ_FAILED'});
    expect(JSON.stringify(rows)).not.toContain(secret); expect(JSON.stringify(rows)).not.toContain('Private display label');
});
it('identifies catalog, version and exposure validation failures without losing their stage', async () => {
    const missing = mount([], {}, undefined, 'removed'); await missing.controller.ready();
    expect(vi.mocked(console.error).mock.calls.at(-1)![1]).toMatchObject({flowId: 'removed', stage: 'selection', code: 'FLOW_NOT_IN_CATALOG', flowCount: 0});
    const version = mount([{id:'a',name:'Flow'}], {getFlowRevision: async () => ({revision:1}), listFlowRevisions:async()=>[{revision:1}]}, 7); await version.controller.ready();
    expect(vi.mocked(console.error).mock.calls.at(-1)![1]).toMatchObject({requestedRevision: 7, stage: 'revision', code: 'FLOW_REVISION_UNAVAILABLE'});
    const local = mount([{id:'a',name:'Flow'}], {getFlowRevision:async()=>({revision:1,exposure:'local'})}); await local.controller.ready();
    expect(vi.mocked(console.error).mock.calls.at(-1)![1]).toMatchObject({stage: 'exposure', code: 'FLOW_EXPOSURE_DENIED'});
});
