import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createApplicationRuntime } from '@itookit/app-core';
import { FlowLibraryCommand } from '@itookit/app-contracts';
import { FlowCommand, type FlowDraft, type FlowRevision } from '@itookit/llm-flow/contracts';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { NodeSqliteSidecarDb } from '@itookit/node-host/storage';
import { CliDirectorySourceProvider } from '../src/directories';
import { NodeNativeShell } from '../src/shell';

const definitionPath = fileURLToPath(new URL('../examples/raptor/raptor-parity.flow', import.meta.url));
const agentPath = fileURLToPath(new URL('../examples/raptor/raptor-parity.agent', import.meta.url));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
type Execution = { command: string; args: string[]; exitCode?: number | null; durationMs?: number };
type TestRuntime = Awaited<ReturnType<typeof createApplicationRuntime>>;

it('keeps RAPTOR parity business rules and comparisons inside the published Flow definition', async () => {
    const definition = JSON.parse(await readFile(definitionPath, 'utf8')) as FlowDraft;
    const agent = JSON.parse(await readFile(agentPath, 'utf8'));
    const nodes = [...definition.nodes, ...(definition.functions ?? []).flatMap(fn => fn.nodes)];
    expect(agent.execution).toMatchObject({ kind: 'flow', flowId: definition.id });
    expect(nodes.every(node => ['builtin.tool', 'builtin.transform', 'builtin.flow'].includes(node.plugin))).toBe(true);
    const commands = nodes.map(node => node.config as { toolId?: string; args?: { command?: string } })
        .filter(config => config.toolId === 'Bash').map(config => config.args?.command ?? '');
    expect(commands.join('\n')).not.toMatch(/raptor\.py\b|raptor_agentic|python\s+-c|node\s+-e/);
    expect(commands.join('\n')).toContain('message:.extra.message');
    expect(commands.join('\n')).toContain('severity:.extra.severity');
    expect(definition.nodes.filter(node => node.id.startsWith('rule-'))).toHaveLength(58);
});

async function workspaceInput() {
    expect(process.env.RAPTOR_PARITY_ROOT).toBeTruthy(); expect(process.env.RAPTOR_PARITY_SEMGREP_BIN).toBeTruthy();
    const root = path.resolve(process.env.RAPTOR_PARITY_ROOT!);
    const workspace = path.resolve(process.env.RAPTOR_PARITY_AGENT_WORKSPACE ?? path.join(root, 'agent-workspace'));
    await mkdir(workspace);
    await Promise.all(['target', 'baseline'].map(name => cp(path.join(root, 'workspace', name), path.join(workspace, name), { recursive: true })));
    const cases = JSON.parse(await readFile(path.join(root, 'cases.json'), 'utf8')).cases as Array<{ id: string }>;
    expect(cases).toHaveLength(70);
    await writeJson(path.join(workspace, 'input-cases.json'), { cases });
    vi.stubEnv('PATH', `${path.dirname(process.env.RAPTOR_PARITY_SEMGREP_BIN!)}:${process.env.PATH}`);
    vi.stubEnv('SEMGREP_ENABLE_VERSION_CHECK', '0'); vi.stubEnv('SEMGREP_SEND_METRICS', 'off');
    vi.stubEnv('SEMGREP_APP_TOKEN', '');
    vi.stubEnv('SEMGREP_LOG_FILE', path.join(workspace, 'semgrep-runtime.log'));
    vi.stubEnv('SEMGREP_SETTINGS_FILE', path.join(workspace, 'semgrep-settings.yaml'));
    return { root, workspace, cases };
}

async function openRuntime(workspace: string, executions: Execution[]) {
    const profile = path.join(workspace, 'profile');
    const backend = await openLocalFSBackend({ rootDir: path.join(profile, 'data'), sidecarDir: path.join(profile, 'metadata'),
        createDb: NodeSqliteSidecarDb.open });
    const shell = new NodeNativeShell();
    return createApplicationRuntime({ backend, ownerKind: 'cli', digitalTwinAutoStart: false,
        defaultSessionDirectory: workspace, directorySourceProvider: new CliDirectorySourceProvider(profile),
        kernelPlatform: { createSessionProcesses: async () => ({ release: async () => {}, nativeShell: {
            capabilities: shell.capabilities, exec: async (command, args, settings) => {
                expect(args.join(' ')).not.toMatch(/raptor\.py\b|raptor_agentic|python\s+-c|node\s+-e/);
                const execution: Execution = { command, args }; executions.push(execution);
                const started = Date.now(), result = await shell.exec(command, args, { ...settings, cwd: workspace });
                execution.exitCode = result.code; execution.durationMs = Date.now() - started;
                return result;
            },
        } }) } });
}

async function publishedAgent(runtime: TestRuntime, cases: unknown[]) {
    const definition = JSON.parse(await readFile(definitionPath, 'utf8')) as FlowDraft;
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [definition] });
    const agent = JSON.parse(await readFile(agentPath, 'utf8'));
    agent.execution.parameters = { cases };
    await runtime.agentService.saveAgent(agent);
    const published = await runtime.commandBus.execute<FlowRevision>(FlowCommand.RevisionGet, { id: definition.id });
    const sessionId = await runtime.sessionRepository.createSession('RAPTOR all-case parity through a published Flow Agent');
    await runtime.commandBus.execute(SessionCommand.Bind, { sessionId });
    return { agent, published, sessionId };
}

async function waitForRound(runtime: TestRuntime, sessionId: string) {
    await vi.waitFor(async () => {
        const [round] = (await runtime.sessionRepository.readHistoryChain(sessionId)).rounds;
        expect(round && ['completed', 'failed', 'cancelled'].includes(round.status)).toBe(true);
    }, { timeout: 1_740_000, interval: 500 });
}

async function recordRun(runtime: TestRuntime, workspace: string, sessionId: string, executions: Execution[],
    binding: Awaited<ReturnType<typeof publishedAgent>>, networkRequests: number) {
    const tasks = await runtime.kernel.kernel.listSessionTasks(sessionId);
    const root = tasks.find(task => task.labels?.kind === 'flow-root');
    const rounds = (await runtime.sessionRepository.readHistoryChain(sessionId)).rounds;
    await Promise.all([writeJson(path.join(workspace, 'agent-record.json'), binding.agent),
        writeJson(path.join(workspace, 'published-flow.json'), binding.published),
        writeJson(path.join(workspace, 'root-task.json'), root ?? null), writeJson(path.join(workspace, 'rounds.json'), rounds)]);
    const evidence = { recordedAt: new Date().toISOString(), source: 'real-semgrep-agent-bound-published-flow',
        definitionSha256: createHash('sha256').update(await readFile(definitionPath)).digest('hex'),
        sessionId, rootTaskId: root?.id, status: root?.status, agentId: binding.agent.id,
        published: { id: binding.published.id, revision: binding.published.revision, digest: binding.published.digest },
        execution: binding.agent.execution, networkRequests, executions,
        tasks: tasks.map(task => ({ id: task.id, nodeId: task.labels?.flowNodeId, status: task.status, error: task.exit?.error })),
        output: root?.output };
    await writeJson(path.join(workspace, 'agent-evidence.json'), evidence);
    return { tasks, root };
}

async function writeJson(file: string, value: unknown) { await writeFile(file, JSON.stringify(value, null, 2) + '\n'); }

async function assertComparisonArtifacts(workspace: string, cases: Array<{ id: string }>) {
    for (const item of cases) {
        const comparison = JSON.parse(await readFile(path.join(workspace, 'flow', `${item.id}.comparison.json`), 'utf8'));
        expect(comparison, item.id).toMatchObject({ passed: true, equal: true, expectationPassed: true, scanExitCode: 0 });
        expect(comparison.actual, item.id).toEqual(comparison.baseline);
        for (const finding of comparison.actual.findings) {
            expect(finding, item.id).toMatchObject({ ruleId: expect.any(String), path: expect.any(String),
                start: { line: expect.any(Number), col: expect.any(Number) }, end: { line: expect.any(Number), col: expect.any(Number) },
                message: expect.any(String), severity: expect.any(String) });
        }
    }
}

it.runIf(process.env.RAPTOR_PARITY_LIVE === '1')('runs all 70 cases through a durable published Flow Agent without a model backend', async () => {
    const input = await workspaceInput(), executions: Execution[] = [];
    const startedAt = Date.now();
    const runtimeSources = ['backend/llm-flow/src/flow/variables.ts', 'backend/llm-flow/src/flow/checkpoint-store.ts',
        'backend/llm-flow/src/flow/programs.ts', 'backend/llm-flow/src/flow/executor.ts',
        'libraries/durable-kernel/src/infrastructure/seqfile/store-helpers.ts'];
    const runtimeHashes = await Promise.all(runtimeSources
        .map(async file => [file, createHash('sha256').update(await readFile(new URL(`../../../${file}`, import.meta.url))).digest('hex')]));
    await writeJson(path.join(input.workspace, 'runtime-source-hashes.json'), Object.fromEntries(runtimeHashes));
    let networkRequests = 0;
    vi.stubGlobal('fetch', () => { networkRequests++; throw new Error('Tool-only RAPTOR parity must not call an LLM or fetch'); });
    let runtime = await openRuntime(input.workspace, executions);
    cleanup.push(() => runtime.dispose());
    const binding = await publishedAgent(runtime, input.cases);
    await runtime.commandBus.execute(SessionCommand.Send, { text: 'Run the complete disposable RAPTOR fixture matrix and compare the original-rule baselines. Do not execute target code.',
        files: [], agentId: binding.agent.id });
    try { await waitForRound(runtime, binding.sessionId); }
    finally { await recordRun(runtime, input.workspace, binding.sessionId, executions, binding, networkRequests); }
    const outcome = await recordRun(runtime, input.workspace, binding.sessionId, executions, binding, networkRequests);
    expect(outcome.root?.status, JSON.stringify(outcome.root?.exit)).toBe('succeeded');
    const summary = JSON.parse(await readFile(path.join(input.workspace, 'flow/summary.json'), 'utf8'));
    expect(summary).toMatchObject({ passed: true, expectedCases: 70, completedCases: 70, baselineFindings: 190, flowFindings: 190,
        missingCaseIds: [], failedCaseIds: [], parityMismatchCaseIds: [], scannerFailureCaseIds: [] });
    await assertComparisonArtifacts(input.workspace, input.cases);
    expect(executions.filter(execution => execution.args.join(' ').includes('semgrep scan'))).toHaveLength(70);
    expect(networkRequests).toBe(0);
    await runtime.dispose(); const reopenStartedAt = Date.now(); runtime = await openRuntime(input.workspace, executions);
    const restored = await runtime.kernel.kernel.listSessionTasks(binding.sessionId);
    expect(restored.find(task => task.id === outcome.root!.id)?.status).toBe('succeeded');
    expect((await runtime.commandBus.execute<FlowRevision>(FlowCommand.RevisionGet, { id: binding.published.id })).digest).toBe(binding.published.digest);
    expect((await runtime.agentService.getAgents()).find(agent => agent.id === binding.agent.id)?.execution).toEqual(binding.agent.execution);
    await writeJson(path.join(input.workspace, 'reopened-evidence.json'), { sessionId: binding.sessionId, rootTaskId: outcome.root!.id,
        status: 'succeeded', persistedAgent: true, publishedDigest: binding.published.digest, networkRequests });
    await writeJson(path.join(input.workspace, 'performance.json'), { startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(), wallDurationMs: Date.now() - startedAt, reopenDurationMs: Date.now() - reopenStartedAt,
        taskCount: outcome.tasks.length, shellCalls: executions.length,
        shellDurationMs: executions.reduce((total, execution) => total + (execution.durationMs ?? 0), 0),
        semgrepDurationMs: executions.filter(execution => execution.args.join(' ').includes('semgrep scan'))
            .reduce((total, execution) => total + (execution.durationMs ?? 0), 0),
        sqliteBytes: (await stat(path.join(input.workspace, 'profile/metadata/index.db'))).size });
}, 1_800_000);
