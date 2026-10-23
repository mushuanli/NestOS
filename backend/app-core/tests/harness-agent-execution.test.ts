import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import type { HarnessClient } from '@itookit/mindos-node-driver';
import type { HarnessConnectionSnapshot } from '@itookit/kernel-adapters/contracts';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { FlowLibraryCommand } from '@itookit/app-contracts';
import type { FlowDraft } from '@itookit/llm-flow/contracts';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';

const connection: HarnessConnectionSnapshot = { id: 'remote', name: 'Remote', kind: 'harness', nodeConnectionId: 'node',
    projectId: 'project', profileId: 'claude', version: 1, revision: 1, project: { serverProjectId: 'native-project' } };
type Runtime = Awaited<ReturnType<typeof createApplicationRuntime>>;
const runtimes: Runtime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup() {
    const fetch = vi.fn(async () => { throw new Error('A remote Agent must not use a local model'); }); vi.stubGlobal('fetch', fetch);
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false });
    runtimes.push(runtime);
    const prompts: string[] = [], sessions: string[] = [];
    vi.spyOn(runtime.executionConnections, 'freeze').mockResolvedValue(connection);
    vi.spyOn(runtime.executionConnections, 'validate').mockResolvedValue();
    vi.spyOn(runtime.executionConnections, 'acquire').mockImplementation(async () => {
        let id = '', turn = '';
        const client = { create: async () => { id = `native-${sessions.length}`; sessions.push(id); return { session: { id } }; },
            turn: async (_profile: string, _session: string, prompt: string) => { prompts.push(prompt); turn = `${id}-turn`; return { turnId: turn }; },
            read: async () => ({ session: { id }, turns: [{ id: turn, status: 'completed', items: [
                { id: `${turn}-text`, type: 'agentMessage', text: `RESULT:${id}` },
            ] }] }),
            subscribe: () => () => {}, close: async () => {},
            eventSnapshot: async () => ({ epoch: 'events', cursor: 2, gap: false, requests: [], events: [
                { seq: 1, message: { method: 'item/completed', params: { threadId: id, turnId: turn,
                    item: { id: `${turn}-text`, type: 'agentMessage', text: `RESULT:${id}` } } } },
                { seq: 2, message: { method: 'turn/completed', params: { threadId: id, turn: { id: turn, status: 'completed' } } } },
            ] }),
        } as unknown as HarnessClient;
        return { client, epoch: 'service', workspaceId: 'native-project', release: async () => {},
            profile: { id: 'claude', kind: 'claude', projectRuntime: true, workspaces: [{ id: 'native-project' }],
                capabilities: { create: true, history: true, interrupt: true, resume: true, interactions: true } } };
    });
    await runtime.agentService.saveAgent({ id: 'remote-agent', name: 'Remote Agent', type: 'agent', config: { systemPrompt: 'REVIEW_INSTRUCTIONS' },
        execution: { kind: 'harness', connectionId: 'remote' } });
    return { runtime, prompts, sessions, fetch };
}
async function send(runtime: Runtime, agentId: string, text: string) {
    const id = await runtime.sessionRepository.createSession('Remote execution');
    await runtime.commandBus.execute(SessionCommand.Bind, { sessionId: id });
    await runtime.commandBus.execute(SessionCommand.Send, { text, files: [], agentId,
        sendIntent: { branch: { mode: 'continue' }, retention: { mode: 'persistent' }, execution: { kind: 'agent', agentId, mode: 'agent' } } });
    await vi.waitFor(async () => {
        const rounds = (await runtime.sessionRepository.readHistoryChain(id)).rounds;
        expect(rounds).toHaveLength(1); expect(rounds[0].status).toBe('completed');
    }, { timeout: 10_000 });
    return { id, tasks: await runtime.kernel.kernel.listSessionTasks(id), rounds: (await runtime.sessionRepository.readHistoryChain(id)).rounds };
}

it('executes an ordinary harness Agent through the real Program and broker without any local model', async () => {
    const f = await setup(), result = await send(f.runtime, 'remote-agent', 'Preserve ${param.literal}');
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain('Preserve ${param.literal}'); expect(f.prompts[0]).toContain('REVIEW_INSTRUCTIONS');
    expect(result.tasks.filter(task => task.program.kind === 'kernel-adapters.harness')).toHaveLength(1);
    expect(result.tasks.some(task => task.program.kind.startsWith('llm.'))).toBe(false);
    expect(JSON.stringify(result.rounds)).toContain('RESULT:native-0');
});

it('runs parallel Flow Agent nodes as independent native sessions and joins their actual results', async () => {
    const f = await setup();
    const flow: FlowDraft = { id: 'remote-workers', name: 'Remote workers', draftVersion: 1, updatedAt: 0,
        nodes: ['one', 'two'].map(id => ({ id, name: id, plugin: 'builtin.agent', pluginVersion: '1.0.0',
            config: { agentId: 'remote-agent', historyPolicy: 'none', instruction: `${id}: \${input.prompt}` }, inputs: {} })),
        edges: [], outputs: { first: { value: '${nodes.one.outputs.result}' }, second: { value: '${nodes.two.outputs.result}' } } } as FlowDraft;
    await f.runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [flow] });
    await f.runtime.agentService.saveAgent({ id: 'flow-agent', name: 'Remote workers', type: 'workflow', config: {}, execution: { kind: 'flow', flowId: flow.id } });
    const result = await send(f.runtime, 'flow-agent', 'Check the project');
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.sessions).toHaveLength(2); expect(new Set(f.sessions).size).toBe(2);
    expect(f.prompts).toHaveLength(2); expect(f.prompts.some(text => text.includes('one: Check the project'))).toBe(true);
    expect(f.prompts.some(text => text.includes('two: Check the project'))).toBe(true);
    expect(result.tasks.filter(task => task.program.kind === 'kernel-adapters.harness' && task.status === 'succeeded')).toHaveLength(2);
    expect(JSON.stringify(result.rounds)).toContain('RESULT:native-0'); expect(JSON.stringify(result.rounds)).toContain('RESULT:native-1');
});
