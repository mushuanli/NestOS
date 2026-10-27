import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createNestOSNodeDriver, type NestOSNodeDriver } from '@itookit/nestos-node-driver';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { FlowLibraryCommand } from '@itookit/app-contracts';
import type { FlowDraft } from '@itookit/llm-flow/contracts';
import type { HarnessExecutionResult } from '@itookit/kernel-adapters/contracts';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { harnessExecutionJournalKey } from '../src/projects/harness-execution';
import { coordinatorConfiguration, fixtureHashes, nativeEvidence, realMetadata, reviewInstruction,
    saveReport, verifyReview, type RealMetadata } from './harness-real-model-fixture';

const metadataPath = process.env.NESTOS_HARNESS_REAL_METADATA;
const coordinatorPath = process.env.NESTOS_REAL_COORDINATOR_CONFIG;
const cases: Array<Record<string, unknown>> = [], observations: Array<Record<string, unknown>> = [], sessions: string[] = [];
const kinds = ['sql', 'shell'] as const;
const responded = new Set<string>();
let runtime: Awaited<ReturnType<typeof createApplicationRuntime>>, driver: NestOSNodeDriver;
let metadata: RealMetadata, nonce: string, folder: string, initialized = false;

beforeAll(async () => {
    if (!metadataPath) return;
    metadata = await realMetadata(metadataPath); nonce = (await readFile(join(metadata.projectDirectory, 'challenge.txt'), 'utf8')).trim();
    driver = createNestOSNodeDriver(); runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli',
        remoteSourceProvider: driver, digitalTwinAutoStart: false });
    const remote = runtime.projects.remoteMounts!;
    const nodeId = await remote.saveConnection({ name: 'Actual model validation', endpoint: metadata.endpoint }, await readFile(metadata.credentialFile, 'utf8'));
    const project = await runtime.projects.createRemote(metadata.project.name, null, nodeId,
        `/${metadata.project.alias}/${metadata.project.path}`, 'rw');
    folder = await runtime.projects.sessionFolder(project);
    await runtime.executionConnections.save({ id: 'actual-native', name: 'Actual native model', kind: 'harness',
        nodeConnectionId: nodeId, projectId: project.project.id, profileId: metadata.profileId }, 0);
    for (const kind of kinds) await runtime.agentService.saveAgent({ id: `native-${kind}`, name: `Native ${kind} reviewer`, type: 'agent',
        config: { systemPrompt: reviewInstruction(`audit-${kind}.py`) }, execution: { kind: 'harness', connectionId: 'actual-native' } });
    initialized = true;
}, 60_000);

afterAll(async () => {
    const cleanup: unknown[] = [];
    if (runtime) for (const id of sessions) for (const task of await runtime.kernel.kernel.listSessionTasks(id)) {
        if (['succeeded', 'failed', 'cancelled'].includes(task.status)) continue;
        const handle = await runtime.kernel.kernel.attachTask(id, task.id);
        try { await handle.cancel('Actual model test cleanup'); await handle.waitStopped({ timeoutMs: 20_000 }); }
        catch { cleanup.push({ taskId: task.id, outcome: 'cleanup-pending' }); }
    }
    try {
        if (metadata) await saveReport(metadata.root, { schemaVersion: 1, status: cases.length === 4 && !cleanup.length ? 'passed' : 'failed',
            cloudModel: true, fixedPeer: false, configuredNativeModel: metadata.configuredModel,
            connectionAndProjectAuthorizationMocked: false, coordinatorModelMocked: false, processRestart: false,
            expectedCases: 4, cweComparison: 'Numeric CWE identity; raw model outputs are retained', initialized, cases, observations, cleanup, fixtureSha256: await fixtureHashes(metadata) });
    } finally { await runtime?.dispose(); await driver?.dispose(); }
});

async function begin(agentId: string, text: string): Promise<string> {
    const sessionId = await runtime.sessionRepository.createSession('Actual model acceptance', folder); sessions.push(sessionId);
    await runtime.commandBus.execute(SessionCommand.Bind, { sessionId });
    await runtime.commandBus.execute(SessionCommand.Send, { text, files: [], agentId,
        sendIntent: { branch: { mode: 'continue' }, retention: { mode: 'persistent' }, execution: { kind: 'agent', agentId, mode: 'agent' } } });
    return sessionId;
}
async function finish(sessionId: string) {
    await vi.waitUntil(async () => {
        const rounds = (await runtime.sessionRepository.readHistoryChain(sessionId)).rounds;
        const tasks = await runtime.kernel.kernel.listSessionTasks(sessionId);
        await answerReadOnlyInteractions(sessionId, tasks);
        const failed = tasks.find(task => task.status === 'failed' || Object.values(task.effects).some(effect => effect.status === 'indeterminate'));
        if (failed) { observations.push({ stage: 'wait', taskId: failed.id, status: failed.status, error: failed.exit?.error }); throw new Error('MODEL_EXECUTION_DID_NOT_SUCCEED'); }
        return rounds.length > 0 && ['completed', 'failed', 'cancelled'].includes(rounds[0].status);
    }, { timeout: 240_000, interval: 250 });
    const history = await runtime.sessionRepository.readHistoryChain(sessionId);
    expect(history.rounds[0].status).toBe('completed');
    return { history, tasks: await runtime.kernel.kernel.listSessionTasks(sessionId) };
}
function authorizedRead(path: unknown): boolean {
    if (typeof path !== 'string') return false;
    const prefix = `/projects/${metadata.project.id}/`;
    const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path.replace(/^\.\//, '');
    return ['audit-sql.py', 'audit-shell.py', 'challenge.txt'].includes(relative);
}
async function answerReadOnlyInteractions(sessionId: string,
    tasks: Awaited<ReturnType<typeof runtime.kernel.kernel.listSessionTasks>>) {
    for (const task of tasks) for (const interaction of Object.values(task.interactions)) {
        const key = `${task.id}:${interaction.id}`;
        if (interaction.status !== 'pending' || responded.has(key)) continue;
        if (interaction.kind !== 'approval') throw new Error('UNEXPECTED_NATIVE_INPUT');
        const payload = interaction.payload as { toolName?: string; path?: string } | undefined;
        const approved = payload?.toolName === 'Read' && authorizedRead(payload.path);
        await (await runtime.kernel.kernel.attachTask(sessionId, task.id)).respond({ interactionId: interaction.id, value: { approved } });
        responded.add(key); observations.push({ stage: 'interaction', taskId: task.id, interactionId: interaction.id,
            toolName: payload?.toolName, approved, policy: 'Read only the three fixture files; decline all other tools' });
    }
}
async function reviews(sessionId: string, expected: readonly ('sql' | 'shell')[]) {
    const session = await runtime.kernel.kernel.inspectSession(sessionId), tasks = await runtime.kernel.kernel.listSessionTasks(sessionId);
    const native = tasks.filter(task => task.program.kind === 'kernel-adapters.harness'); expect(native).toHaveLength(expected.length);
    const snapshot = (await runtime.executionConnections.freeze('actual-native'))!, acquired = await runtime.executionConnections.acquire(snapshot);
    try {
        return await Promise.all(native.map(async task => {
            expect(task.status).toBe('succeeded');
            const output = task.output as { message: { content: string }; harness: HarnessExecutionResult };
            const kind = expected.find(kind => output.message.content.includes(kind === 'sql' ? 'lookup_record' : 'run_job'));
            expect(kind).toBeDefined(); const review = verifyReview(output.message.content, nonce, kind!);
            const entry = await session.getShared(harnessExecutionJournalKey({ sessionId, taskId: task.id, effectId: 'harness' }));
            expect(entry?.value).toMatchObject({ terminal: 'completed', outputChecked: true, result: { text: output.message.content } });
            const evidence = await nativeEvidence(acquired.client, metadata.profileId, output.harness.sessionId);
            const result = { kind, taskId: task.id, nativeSessionId: output.harness.sessionId, nativeTurnId: output.harness.turnId,
                review, output: output.message.content, ...evidence }; observations.push(result); return result;
        }));
    } finally { await acquired.release(); }
}
async function publishFlow() {
    const flow: FlowDraft = { id: 'actual-review-workers', name: 'Actual native reviewers', draftVersion: 1, updatedAt: 0,
        nodes: kinds.map(kind => ({ id: kind, name: kind, plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
            config: { agentId: `native-${kind}`, historyPolicy: 'none', instruction: reviewInstruction(`audit-${kind}.py`) } })), edges: [],
        outputs: { sql: { value: '${nodes.sql.outputs.result}' }, shell: { value: '${nodes.shell.outputs.result}' } } } as FlowDraft;
    await writeFile(join(metadata.root, 'actual-review.flow'), JSON.stringify(flow, null, 2) + '\n');
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [flow] });
    await runtime.agentService.saveAgent({ id: 'actual-flow', name: 'Actual reviewer Flow', type: 'workflow', config: {},
        execution: { kind: 'flow', flowId: flow.id } });
}
async function prepareTeam() {
    if (!coordinatorPath) throw new Error('REAL_COORDINATOR_CONFIGURATION_REQUIRED');
    const model = await coordinatorConfiguration(coordinatorPath);
    await runtime.agentService.saveProvider(model.provider); await runtime.agentService.saveConnection(model.connection);
    await runtime.agentService.saveAgent({ id: 'actual-coordinator', name: 'Actual model coordinator', type: 'agent',
        modelDefaults: { chat: model.connection.id }, capabilityPolicy: { toolIds: [], mcpProfileIds: [] },
        config: { systemPrompt: 'You must delegate one review to native-sql and one to native-shell using delegate_tasks in a single batch. '
            + 'Each member must read its audit file and challenge.txt and return its own JSON review. You cannot inspect project files yourself. '
            + 'In the final summary, include their exact challenge nonce, CWE identifiers and vulnerable/safe function names. Do not delegate again in the summary step.' } });
    await runtime.agentService.saveAgent({ id: 'actual-team', name: 'Actual model team', type: 'composite', config: {},
        composition: { coordinatorAgentId: 'actual-coordinator', memberAgentIds: ['native-sql', 'native-shell'], maxDelegations: 2, maxConcurrency: 2 } });
    return { modelId: model.modelId, endpointOrigin: new URL(model.provider.baseURL!).origin };
}

describe.skipIf(!metadataPath)('real configured models through authorized remote harness execution', () => {
    it('reads an unseen project challenge and independently identifies unsafe and safe SQL functions', async () => {
        const started = Date.now(), id = await begin('native-sql', reviewInstruction('audit-sql.py'));
        await finish(id); const native = await reviews(id, ['sql']);
        cases.push({ name: 'ordinary-agent', sessionId: id, native, durationMs: Date.now() - started, status: 'passed' });
    }, 300_000);
    it('runs a pure Flow with two isolated real native reviewers and joins their results', async () => {
        const started = Date.now(); await publishFlow();
        const id = await begin('actual-flow', 'Review both audit files using the registered reviewers.');
        const result = await finish(id), native = await reviews(id, kinds);
        expect(new Set(native.map(item => item.nativeSessionId)).size).toBe(2);
        expect(result.tasks.filter(task => task.program.kind.startsWith('llm.'))).toHaveLength(0);
        expect(JSON.stringify(result.history)).toContain(nonce);
        cases.push({ name: 'parallel-flow', sessionId: id, native, durationMs: Date.now() - started, status: 'passed' });
    }, 300_000);
    it('uses a real coordinator model to delegate to real remote members and summarize their actual reviews', async () => {
        const started = Date.now(), coordinator = await prepareTeam();
        const id = await begin('actual-team', 'Review audit-sql.py and audit-shell.py with both specialist members. '
            + 'The members must read challenge.txt; include its exact nonce and all confirmed CWE and safe-function names in the final summary.');
        const result = await finish(id), native = await reviews(id, kinds);
        const localTasks = result.tasks.filter(task => task.program.kind.startsWith('llm.')); expect(localTasks).toHaveLength(2);
        expect(localTasks.every(task => task.status === 'succeeded')).toBe(true);
        const summary = result.tasks.find(task => task.labels?.flowNodeId === 'summary')!;
        const text = JSON.stringify(summary.output); expect(text).toContain(nonce); expect(text).toMatch(/CWE-0*89\b/); expect(text).toMatch(/CWE-0*78\b/);
        cases.push({ name: 'composite', coordinator, sessionId: id, native, summary: summary.output,
            coordinatorTaskIds: localTasks.map(task => task.id), durationMs: Date.now() - started, status: 'passed' });
    }, 360_000);
    it('recovers a lost real-model turn response through the same Kernel Effect and original native receipt', async () => {
        const started = Date.now(), counts = { create: 0, turn: 0, receipt: 0 }, accepted = { sessionId: '', turnId: '' };
        const original = runtime.executionConnections.acquire.bind(runtime.executionConnections);
        const spy = vi.spyOn(runtime.executionConnections, 'acquire').mockImplementation(async snapshot => {
            const acquired = await original(snapshot), client = acquired.client;
            const create = client.create.bind(client), turn = client.turn.bind(client), operation = client.operation.bind(client);
            client.create = async (...args) => { counts.create++; const result = await create(...args); accepted.sessionId = result.session.id; return result; };
            client.turn = async (...args) => { counts.turn++; const result = await turn(...args); accepted.turnId = result.turnId; throw new Error('Injected committed reply loss'); };
            client.operation = async (...args) => { counts.receipt++; return operation(...args); }; return acquired;
        });
        try {
            const id = await begin('native-sql', reviewInstruction('audit-sql.py'));
            await vi.waitUntil(async () => (await runtime.kernel.kernel.listSessionTasks(id))[0]?.effects.harness?.status === 'indeterminate', { timeout: 60_000 });
            const task = (await runtime.kernel.kernel.listSessionTasks(id)).find(task => task.program.kind === 'kernel-adapters.harness')!;
            await (await runtime.kernel.kernel.attachTask(id, task.id)).resolveEffect({ requestId: 'verify-original-real-turn', effectId: 'harness', outcome: { type: 'retry' } });
            await finish(id); const native = await reviews(id, ['sql']);
            expect(counts).toEqual({ create: 1, turn: 1, receipt: 1 });
            expect(native[0]).toMatchObject({ nativeSessionId: accepted.sessionId, nativeTurnId: accepted.turnId });
            cases.push({ name: 'kernel-reply-loss-recovery', sessionId: id, counts, accepted, native, durationMs: Date.now() - started, status: 'passed' });
        } finally { spy.mockRestore(); }
    }, 300_000);
});
