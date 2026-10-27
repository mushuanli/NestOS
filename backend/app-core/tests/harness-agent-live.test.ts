import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createNestOSNodeDriver, type NestOSNodeDriver, type RemoteProject } from '@itookit/nestos-node-driver';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { FlowLibraryCommand } from '@itookit/app-contracts';
import type { FlowDraft } from '@itookit/llm-flow/contracts';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { harnessExecutionJournalKey } from '../src/projects/harness-execution';

const metadataFile = process.env.NESTOS_HARNESS_LIVE_METADATA;
const runId = process.env.NESTOS_HARNESS_LIVE_RUN_ID;
const recoveryOnly = process.env.NESTOS_HARNESS_LIVE_RECOVERY_ONLY === '1';
const expectedCases = recoveryOnly ? 1 : 4;
type Runtime = Awaited<ReturnType<typeof createApplicationRuntime>>;
let runtime: Runtime, driver: NestOSNodeDriver, folder: string, root: string;
const results: Array<Record<string, unknown>> = [];
const nativeObservations: Array<Record<string, unknown>> = [];
type ModelRequest = { stream?: boolean; messages: Array<{ role: string; content: string }> };
const coordinatorRequests: ModelRequest[] = [];

beforeAll(async () => {
    if (!metadataFile) return;
    if (runId && !/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Invalid live evidence run ID');
    const metadata = JSON.parse(await readFile(resolve(metadataFile), 'utf8')) as {
        endpoint: string; project: RemoteProject; credentialFile: string; profileId: string; root: string;
    };
    root = metadata.root;
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, options?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith('http://coordinator.fixture/')) return nativeFetch(input, options);
        const request = JSON.parse(String(options?.body)) as ModelRequest; coordinatorRequests.push(request);
        const summary = request.messages.some(message => message.content.includes('Produce the final answer yourself'));
        const message = summary ? { role: 'assistant', content: 'FINAL_NATIVE_REVIEW' } : { role: 'assistant', content: '', tool_calls: [
            { id: 'delegate-native', type: 'function', function: { name: 'delegate_tasks', arguments: JSON.stringify({
                items: [{ agentId: 'native-agent', instruction: 'Reply with the fixed fixture text' }],
            }) } },
        ] };
        return Promise.resolve(completion(request, message));
    });
    driver = createNestOSNodeDriver();
    runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', remoteSourceProvider: driver,
        digitalTwinAutoStart: false });
    const remote = runtime.projects.remoteMounts!;
    const nodeId = await remote.saveConnection({ name: 'Live fixture node', endpoint: metadata.endpoint }, await readFile(metadata.credentialFile, 'utf8'));
    const project = await runtime.projects.createRemote(metadata.project.name, null, nodeId,
        `/${metadata.project.alias}/${metadata.project.path}`, 'rw');
    folder = await runtime.projects.sessionFolder(project);
    await runtime.executionConnections.save({ id: 'live-native', name: 'Live Claude', kind: 'harness',
        nodeConnectionId: nodeId, projectId: project.project.id, profileId: metadata.profileId }, 0);
    const frozen = await runtime.executionConnections.freeze('live-native');
    expect(frozen).toMatchObject({ version: 1, revision: 1, project: { serverProjectId: metadata.project.id } });
    await runtime.agentService.saveAgent({ id: 'native-agent', name: 'Native Claude', type: 'agent', config: { systemPrompt: 'Review the remote project.' },
        execution: { kind: 'harness', connectionId: 'live-native' } });
}, 60_000);

afterAll(async () => {
    try {
        if (root) await writeFile(resolve(root, runId ? `app-runtime-report-${runId}.json` : 'app-runtime-report.json'), JSON.stringify({
            schemaVersion: 1, runId, nativeCLI: true, cloudModel: false, connectionAndProjectAuthorizationMocked: false,
            coordinatorModelFixture: !recoveryOnly, status: results.length === expectedCases ? 'passed' : 'failed', expectedCases,
            cases: results, completedCases: results.length, nativeObservations,
        }, null, 2) + '\n');
    } finally { await runtime?.dispose(); await driver?.dispose(); vi.unstubAllGlobals(); }
});

async function send(agentId: string, localCoordinator = false) {
    return finishSession(await beginSession(agentId), agentId, localCoordinator);
}

async function beginSession(agentId: string) {
    const sessionId = await runtime.sessionRepository.createSession('Live native execution', folder);
    await runtime.commandBus.execute(SessionCommand.Bind, { sessionId });
    await runtime.commandBus.execute(SessionCommand.Send, { text: 'Reply with the fixed fixture text', files: [], agentId,
        sendIntent: { branch: { mode: 'continue' }, retention: { mode: 'persistent' }, execution: { kind: 'agent', agentId, mode: 'agent' } } });
    return sessionId;
}

async function finishSession(sessionId: string, agentId: string, localCoordinator = false) {
    await vi.waitUntil(async () => {
        const rounds = (await runtime.sessionRepository.readHistoryChain(sessionId)).rounds;
        return rounds.length === 1 && ['completed', 'failed', 'cancelled'].includes(rounds[0].status);
    }, { timeout: 90_000, interval: 100 });
    const rounds = (await runtime.sessionRepository.readHistoryChain(sessionId)).rounds;
    if (rounds[0].status !== 'completed') {
        const tasks = await runtime.kernel.kernel.listSessionTasks(sessionId);
        nativeObservations.push({ agentId, sessionId, status: rounds[0].status,
            errors: tasks.filter(task => task.exit?.error).map(task => ({ taskId: task.id, code: task.exit?.error?.code, message: task.exit?.error?.message })) });
    }
    expect(rounds[0].status).toBe('completed');
    const tasks = await runtime.kernel.kernel.listSessionTasks(sessionId);
    const modelTaskCount = tasks.filter(task => task.program.kind.startsWith('llm.')).length;
    expect(modelTaskCount).toBe(localCoordinator ? 2 : 0);
    const members = tasks.filter(task => task.program.kind === 'kernel-adapters.harness');
    const session = await runtime.kernel.kernel.inspectSession(sessionId);
    const native = await Promise.all(members.map(async task => {
        expect(task.status).toBe('succeeded');
        const output = task.output as { message: { content: string }; harness: { sessionId: string; turnId: string } };
        const journal = await session.getShared(harnessExecutionJournalKey({ sessionId, taskId: task.id, effectId: 'harness' }));
        const state = journal?.value as Record<string, unknown> | undefined;
        const savedResult = state?.result as { text?: string } | undefined;
        nativeObservations.push({ agentId, sessionId, taskId: task.id, flowNodeId: task.labels?.flowNodeId,
            nativeSessionId: output.harness.sessionId, nativeTurnId: output.harness.turnId, text: output.message.content,
            outputLength: output.message.content.length, journalResultTextLength: savedResult?.text?.length,
            terminal: state?.terminal, outputChecked: state?.outputChecked, texts: state?.texts, cursor: state?.cursor, journal: state });
        expect(output.message.content).toBe('Claude harness fixture reply');
        expect(savedResult?.text).toBe(output.message.content);
        expect(journal?.value).toMatchObject({ terminal: 'completed', outputChecked: true,
            operations: { create: { outcome: 'committed' }, turn: { outcome: 'committed' } } });
        return { taskId: task.id, program: task.program, status: task.status, nativeSessionId: output.harness.sessionId,
            nativeTurnId: output.harness.turnId, output: output.message.content };
    }));
    return { agentId, sessionId, native, modelTaskCount, status: 'passed' };
}

function completion(request: ModelRequest, message: Record<string, unknown>) {
    const finish = message.tool_calls ? 'tool_calls' : 'stop';
    if (!request.stream) return new Response(JSON.stringify({ id: 'fixture', choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
    const delta = { ...message, ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call as object, index })) } : {}) };
    const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    return new Response(chunk({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })
        + chunk({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

function dropCommittedTurnReply() {
    const counts = { create: 0, turn: 0, receipt: 0 }, accepted = { sessionId: '', turnId: '' };
    const acquire = runtime.executionConnections.acquire.bind(runtime.executionConnections);
    let dropped = false;
    const spy = vi.spyOn(runtime.executionConnections, 'acquire').mockImplementation(async snapshot => {
        const acquired = await acquire(snapshot), client = acquired.client;
        const create = client.create.bind(client), turn = client.turn.bind(client), operation = client.operation.bind(client);
        client.create = async (...args) => { counts.create++; const result = await create(...args); accepted.sessionId = result.session.id; return result; };
        client.turn = async (...args) => {
            counts.turn++; const result = await turn(...args); accepted.turnId = result.turnId;
            if (!dropped) { dropped = true; throw new Error('Injected reply loss after native commit'); }
            return result;
        };
        client.operation = async (...args) => { counts.receipt++; return operation(...args); };
        return acquired;
    });
    return { counts, accepted, restore: () => spy.mockRestore() };
}

async function waitForIndeterminate(sessionId: string) {
    const read = async () => (await runtime.kernel.kernel.listSessionTasks(sessionId))
        .find(task => task.program.kind === 'kernel-adapters.harness');
    try {
        await vi.waitUntil(async () => (await read())?.effects.harness?.status === 'indeterminate', { timeout: 30_000, interval: 100 });
    } catch (error) {
        const tasks = await runtime.kernel.kernel.listSessionTasks(sessionId);
        nativeObservations.push({ case: 'kernel-recovery-gate-failure', sessionId,
            tasks: tasks.map(task => ({ taskId: task.id, program: task.program, status: task.status,
                error: task.exit?.error, effects: Object.fromEntries(Object.entries(task.effects).map(([id, effect]) =>
                    [id, { status: effect.status, attemptCount: effect.attemptCount, error: effect.error }])) })) });
        throw error;
    }
    const task = (await read())!;
    expect(task.status).toBe('waiting');
    const session = await runtime.kernel.kernel.inspectSession(sessionId);
    const journal = await session.getShared(harnessExecutionJournalKey({ sessionId, taskId: task.id, effectId: 'harness' }));
    expect(journal?.value).toMatchObject({ operations: { create: { outcome: 'committed' }, turn: { outcome: 'pending' } } });
    return { task, journal: journal?.value };
}

describe.skipIf(!metadataFile)('AppRuntime through a registered project and installed native Claude CLI', () => {
    it.skipIf(recoveryOnly)('executes an ordinary harness Agent from Session.Send without a local model connection', async () => {
        const result = await send('native-agent');
        expect(result.native).toHaveLength(1); results.push(result);
    }, 120_000);

    it.skipIf(recoveryOnly)('runs two native Flow workers in separate sessions and joins their assistant text', async () => {
        const flow: FlowDraft = { id: 'live-workers', name: 'Live workers', draftVersion: 1, updatedAt: 0,
            nodes: ['one', 'two'].map(id => ({ id, name: id, plugin: 'builtin.agent', pluginVersion: '1.0.0',
                config: { agentId: 'native-agent', historyPolicy: 'none', instruction: `${id}: \${input.prompt}` }, inputs: {} })),
            edges: [], outputs: { one: { value: '${nodes.one.outputs.result}' }, two: { value: '${nodes.two.outputs.result}' } } } as FlowDraft;
        await runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [flow] });
        await runtime.agentService.saveAgent({ id: 'live-flow-agent', name: 'Live workers', type: 'workflow', config: {},
            execution: { kind: 'flow', flowId: flow.id } });
        const result = await send('live-flow-agent');
        expect(result.native).toHaveLength(2); expect(new Set(result.native.map(item => item.nativeSessionId)).size).toBe(2);
        expect(JSON.stringify((await runtime.sessionRepository.readHistoryChain(result.sessionId)).rounds)).toContain('Claude harness fixture reply');
        results.push(result);
    }, 120_000);

    it.skipIf(recoveryOnly)('uses a fixture local coordinator to select a real native member and summarize its result through the managed Flow', async () => {
        await runtime.agentService.saveProvider({ id: 'fixture', name: 'Fixture coordinator', implementation: 'openai-compatible',
            baseURL: 'http://coordinator.fixture', apiKey: 'fixture-only', models: [{ id: 'coordinator-model', name: 'Coordinator fixture' }] });
        await runtime.agentService.saveConnection({ id: 'coordinator', name: 'Coordinator fixture', providerId: 'fixture',
            protocol: 'openai-chat', tiers: { optimal: 'coordinator-model' } });
        await runtime.agentService.saveAgent({ id: 'local-coordinator', name: 'Local coordinator', type: 'agent', config: {},
            modelDefaults: { chat: 'coordinator' }, capabilityPolicy: { toolIds: [], mcpProfileIds: [] } });
        await runtime.agentService.saveAgent({ id: 'native-team', name: 'Native team', type: 'composite', config: {},
            composition: { coordinatorAgentId: 'local-coordinator', memberAgentIds: ['native-agent'], maxDelegations: 1, maxConcurrency: 1 } });
        const result = await send('native-team', true);
        expect(result.native).toHaveLength(1); expect(coordinatorRequests).toHaveLength(2);
        const summary = coordinatorRequests.find(request => request.messages.some(message => message.content.includes('Produce the final answer yourself')))!;
        expect(JSON.stringify(summary.messages)).toContain('Claude harness fixture reply');
        expect(JSON.stringify((await runtime.sessionRepository.readHistoryChain(result.sessionId)).rounds)).toContain('FINAL_NATIVE_REVIEW');
        expect(new Set(nativeObservations.map(item => item.nativeSessionId)).size).toBe(4);
        results.push({ ...result, coordinatorModelFixture: true, coordinatorRequests: coordinatorRequests.length });
    }, 120_000);

    it('recovers a real committed native turn through the Kernel indeterminate gate without resubmission', async () => {
        const fault = dropCommittedTurnReply();
        try {
            const sessionId = await beginSession('native-agent'), pending = await waitForIndeterminate(sessionId);
            expect(fault.counts).toEqual({ create: 1, turn: 1, receipt: 0 });
            expect(fault.accepted.sessionId).toBeTruthy(); expect(fault.accepted.turnId).toBeTruthy();
            const task = await runtime.kernel.kernel.attachTask(sessionId, pending.task.id);
            await task.resolveEffect({ effectId: 'harness', outcome: { type: 'retry' }, requestId: 'verify-native-receipt' });
            const result = await finishSession(sessionId, 'native-agent');
            expect(result.native).toHaveLength(1);
            expect(result.native[0]).toMatchObject({ taskId: pending.task.id,
                nativeSessionId: fault.accepted.sessionId, nativeTurnId: fault.accepted.turnId });
            expect(fault.counts).toEqual({ create: 1, turn: 1, receipt: 1 });
            const events = (await task.readEvents()).items.map(event => event.type);
            expect(events).toContain('effect.indeterminate');
            results.push({ ...result, case: 'kernel-live-lost-reply-recovery', processRestart: false,
                fault: 'drop real committed turn reply', resolution: 'TaskHandle.resolveEffect retry', counts: fault.counts,
                accepted: fault.accepted, pendingTaskStatus: pending.task.status,
                pendingEffectStatus: pending.task.effects.harness.status, pendingJournal: pending.journal, kernelEvents: events });
        } catch (error) {
            nativeObservations.push({ case: 'kernel-recovery-fault-observation', counts: fault.counts, accepted: fault.accepted });
            throw error;
        } finally { fault.restore(); }
    }, 120_000);
});
