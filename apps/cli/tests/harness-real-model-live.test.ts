import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApplicationRuntime, harnessExecutionJournalKey } from '@itookit/app-core';
import { createMindOSNodeDriver, type HarnessUsage, type RemoteProject } from '@itookit/mindos-node-driver';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { NodeSqliteSidecarDb } from '@itookit/node-host/storage';
import { SeqFileKernelStore } from '@itookit/durable-kernel';
import { CliStorageResolver, cliStorage, openProfileInspectionFs } from '../src/runtime';
import { RunStore } from '../src/run-store';
import type { PendingInteraction } from '../src/types';

const metadataFile = process.env.MINDOS_HARNESS_REAL_METADATA;
const instruction = 'Use the native Read tool to read challenge.txt in this project. Do not use Bash. '
    + 'Do not include commentary or Markdown. Return only one JSON object with exactly these keys: '
    + 'nonce (the full file content trimmed), result (the numeric value of 7*13).';
interface Metadata { endpoint: string; project: RemoteProject; credentialFile: string; profileId: string; root: string;
    projectDirectory: string; cloudModel: boolean; fixedPeer: boolean; configuredModel: string; modelEndpointHost: string }
interface Fixture { directory: string; profile: string; workspace: string; credential: string; credentialReference: string; nonce: string; metadata: Metadata }
interface Scenario { name: string; file: string; extra: string[] }
const sha256 = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');

async function prepare(metadata: Metadata): Promise<Fixture> {
    expect(metadata.cloudModel).toBe(true); expect(metadata.fixedPeer).toBe(false);
    const directory = await mkdtemp(join(metadata.root, 'cli-real-')), profile = join(directory, 'profile');
    const credential = await readFile(metadata.credentialFile, 'utf8'), nonce = (await readFile(join(metadata.projectDirectory, 'challenge.txt'), 'utf8')).trim();
    expect(nonce.length > 16 && !instruction.includes(nonce)).toBe(true);
    let credentialReference = ''; const workspace = join(directory, 'workspace'); await mkdir(workspace, { recursive: true });
    const backend = await openLocalFSBackend({ rootDir: profile, sidecarDir: join(profile, '_meta'), createDb: NodeSqliteSidecarDb.open });
    const driver = createMindOSNodeDriver(), runtime = await createApplicationRuntime({ backend, ownerKind: 'cli', remoteSourceProvider: driver,
        digitalTwinAutoStart: false });
    try {
        const nodeId = await runtime.projects.remoteMounts!.saveConnection({ name: 'Real native model fixture', endpoint: metadata.endpoint }, credential);
        credentialReference = runtime.projects.remoteMounts!.connection(nodeId).credentialRef;
        const project = await runtime.projects.createRemote(metadata.project.name, null, nodeId,
            `/${metadata.project.alias}/${metadata.project.path}`, 'rw');
        for (const id of ['cli-native-real', 'remote-review']) await runtime.executionConnections.save({ id, name: id, kind: 'harness',
            nodeConnectionId: nodeId, projectId: project.project.id, profileId: metadata.profileId }, 0);
        await runtime.agentService.saveAgent({ id: 'cli-native-real-agent', name: 'Real native Agent', type: 'agent', config: {},
            execution: { kind: 'harness', connectionId: 'cli-native-real' } });
    } finally { await runtime.dispose(); await driver.dispose(); }
    return { directory, profile, workspace, credential, credentialReference, nonce, metadata };
}

async function scenarios(f: Fixture): Promise<Scenario[]> {
    const file = join(f.directory, 'agent-reference.flow'), params = join(f.directory, 'params.json');
    await writeFile(file, JSON.stringify({ id: 'cli-real-agent-reference', name: 'Real native Agent reference', draftVersion: 1, updatedAt: 0,
        nodes: [{ id: 'remote', name: 'Remote', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
            config: { agentId: 'cli-native-real-agent', historyPolicy: 'none', instruction } }],
        edges: [], outputs: { result: { value: '${nodes.remote.outputs.result}' } } }, null, 2));
    await writeFile(params, JSON.stringify({ request: instruction }));
    return [{ name: 'shipped-inline-example', file: resolve('examples/remote-harness.flow'), extra: ['--params', params] },
        { name: 'agent-reference', file, extra: [] }];
}

async function inspectJournal(f: Fixture, run: Awaited<ReturnType<RunStore['load']>>, native: { sessionId: string; turnId: string }) {
    const inspection = await openProfileInspectionFs(f.profile);
    try {
        const resolver = new CliStorageResolver(inspection.fs), binding = await resolver.resolve(cliStorage(run.id));
        const store = new SeqFileKernelStore(binding, reference => resolver.resolve(reference)), tasks = await store.listTasks(binding);
        const workers = tasks.filter(task => task.program.kind === 'kernel-adapters.harness'); expect(workers).toHaveLength(1);
        expect(workers[0].status).toBe('succeeded'); expect(tasks.some(task => task.program.kind.startsWith('llm.'))).toBe(false);
        const key = harnessExecutionJournalKey({ sessionId: run.sessionId, taskId: workers[0].id, effectId: 'harness' });
        const journal = (await store.getShared(binding, key))?.value as any;
        expect(journal).toMatchObject({ terminal: 'completed', outputChecked: true, sessionId: native.sessionId, turnId: native.turnId,
            operations: { create: { outcome: 'committed' }, turn: { outcome: 'committed' } } });
        return { key, taskId: workers[0].id, terminal: journal.terminal, outputChecked: journal.outputChecked,
            create: { requestId: journal.operations.create.requestId, outcome: journal.operations.create.outcome },
            turn: { requestId: journal.operations.turn.requestId, outcome: journal.operations.turn.outcome } };
    } finally { await inspection.dispose(); }
}

function hasRead(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasRead);
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, unknown>;
    if (['functionCall', 'tool_use'].includes(String(item.type)) && item.name === 'Read'
        && JSON.stringify(item.arguments ?? item.input)?.includes('challenge.txt')) return true;
    return Object.values(item).some(hasRead);
}

async function verifyNativeRead(f: Fixture, sessionId: string): Promise<HarnessUsage | undefined> {
    const driver = createMindOSNodeDriver(); driver.setCredential('cli-real-inspection', f.credential);
    const projects = driver.projects({ endpoint: f.metadata.endpoint, credentialRef: 'cli-real-inspection' });
    const client = projects.harness(await projects.read(f.metadata.project.id));
    try {
        let usage: HarnessUsage | undefined;
        await vi.waitFor(async () => {
            expect(hasRead((await client.read(f.metadata.profileId, sessionId)).turns)).toBe(true);
            usage = await client.usage?.(f.metadata.profileId, sessionId);
            expect(usage?.entries.some(entry => entry.modelId && entry.tokens.outputTokens > 0)).toBe(true);
        }, { timeout: 15_000, interval: 100 });
        return usage;
    } finally { await client.close(); await projects.close(); await driver.dispose(); }
}

async function execute(f: Fixture, scenario: Scenario) {
    const started = Date.now(), interactions = await runCli(f, scenario);
    const store = new RunStore(join(f.profile, 'var/lib/cli-runs'));
    const run = (await store.list()).sort((a, b) => b.createdAt - a.createdAt)[0]; expect(run.status, run.error).toBe('succeeded');
    const artifactFile = join(store.runDir(run.id), 'artifacts/remote/result.json');
    const artifact = JSON.parse(await readFile(artifactFile, 'utf8')), parsed = parseResult(artifact.harness.text);
    expect(parsed.nonce === f.nonce, 'native output must match the unread challenge value').toBe(true); expect(parsed.result).toBe(91);
    expect(Object.keys(parsed).sort()).toEqual(['nonce', 'result']);
    const journal = await inspectJournal(f, run, artifact.harness), usage = await verifyNativeRead(f, artifact.harness.sessionId);
    return { name: scenario.name, exitCode: 0, status: run.status, runId: run.id, rootTaskId: run.rootTaskId,
        nativeSessionId: artifact.harness.sessionId, nativeTurnId: artifact.harness.turnId, journal, interactions, readToolObserved: true,
        outputLength: artifact.harness.text.length, outputSha256: sha256(artifact.harness.text), nonceMatches: true, result: parsed.result,
        usage, observedModelIds: [...new Set(usage?.entries.flatMap(entry => entry.modelId ? [entry.modelId] : []) ?? [])],
        durationMs: Date.now() - started, artifactFile, flowFile: scenario.file, flowSha256: sha256(await readFile(scenario.file)) };
}

function parseResult(text: string): { nonce: unknown; result: unknown } {
    try { return JSON.parse(text.trim()); }
    catch { throw new Error('Native response did not contain the requested JSON object; inspect the saved artifact'); }
}

async function runCli(f: Fixture, scenario: Scenario) {
    let code = await command(f, scenario.name, ['run', '-f', scenario.file, '--set-home', f.workspace, ...scenario.extra]);
    const initialExitCode = code, decisions = [], store = new RunStore(join(f.profile, 'var/lib/cli-runs'));
    const run = (await store.list()).sort((a, b) => b.createdAt - a.createdAt)[0];
    for (let cycle = 0; code === 3 && cycle < 8; cycle++) {
        const current = await store.load(run.id); expect(current.pendingInteractions.length > 0, 'unknown outcomes must not be blindly retried').toBe(true);
        for (const pending of current.pendingInteractions) {
            const decision = approval(f, pending); decisions.push({ interactionId: pending.interactionId, ...decision });
            expect(await command(f, `${scenario.name}.respond-${cycle}-${decisions.length}`, ['respond', run.id, pending.interactionId,
                '--value', JSON.stringify({ approved: decision.approved })])).toBe(0);
        }
        code = await command(f, `${scenario.name}.resume-${cycle}`, ['resume', run.id]);
    }
    expect(code, 'same CLI Run must finish through approved Read or denied unsafe requests').toBe(0);
    return { initialExitCode, finalExitCode: code, decisions };
}

function approval(f: Fixture, pending: PendingInteraction) {
    expect(pending.kind, 'fixture policy does not answer arbitrary native input questions').toBe('approval');
    const payload = pending.payload as { toolName?: string; path?: string } | undefined;
    const allowed = ['challenge.txt', './challenge.txt', '/workspace/challenge.txt', `/projects/${f.metadata.project.id}/challenge.txt`];
    return { toolName: payload?.toolName ?? 'unknown', approved: payload?.toolName === 'Read' && allowed.includes(payload.path ?? '') };
}

async function command(f: Fixture, label: string, operation: string[]): Promise<number> {
    const args = ['--import', 'tsx', resolve('src/cli.ts'), ...operation, '--profile', f.profile, '--headless', '--json'], started = Date.now();
    const result = await promisify(execFile)(process.execPath, args, { timeout: 240_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, MINDOS_DIAGNOSTICS_DIR: join(f.directory, 'diagnostics'),
            [`MINDOS_REMOTE_${f.credentialReference.replace(/-/g, '_')}`]: f.credential } })
        .then(value => ({ ...value, code: 0 })).catch(error => ({ stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), code: error.code }));
    const { stdout, stderr } = result;
    expect(stdout.includes(f.credential) || stderr.includes(f.credential)).toBe(false);
    await writeFile(join(f.directory, `${label}.stdout.jsonl`), stdout);
    await writeFile(join(f.directory, `${label}.stderr.log`), stderr);
    await writeFile(join(f.directory, `${label}.command.json`), JSON.stringify({ exitCode: result.code, durationMs: Date.now() - started }, null, 2));
    expect([0, 3].includes(result.code), 'CLI command must complete or request a durable decision; inspect its diagnostic log').toBe(true);
    return result.code;
}

describe.skipIf(!metadataFile)('real CLI .flow through an installed native harness and configured LAN model gateway', () => {
    it('executes the shipped inline example and a profile Agent using a file challenge absent from the prompt', async () => {
        const metadata: Metadata = JSON.parse(await readFile(resolve(metadataFile!), 'utf8')), f = await prepare(metadata), cases = [];
        for (const scenario of await scenarios(f)) {
            cases.push(await execute(f, scenario));
            await writeFile(join(f.directory, 'cli-real-model-report.json'), JSON.stringify({ schemaVersion: 1, cloudModel: true,
                fixedPeer: false, modelRoute: 'configured LAN gateway', modelEndpointHost: metadata.modelEndpointHost,
                configuredModel: metadata.configuredModel, nativeCLI: true, nonceAbsentFromPrompt: true, nonceSha256: sha256(f.nonce), cases }, null, 2) + '\n');
        }
    }, 540_000);
});
