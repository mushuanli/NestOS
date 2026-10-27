import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApplicationRuntime } from '@itookit/app-core';
import { createNestOSNodeDriver, type RemoteProject } from '@itookit/nestos-node-driver';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { NodeSqliteSidecarDb } from '@itookit/node-host/storage';
import { RunStore } from '../src/run-store';

const metadataFile = process.env.NESTOS_HARNESS_LIVE_METADATA;

interface Metadata { endpoint: string; project: RemoteProject; credentialFile: string; profileId: string; root: string }
interface Fixture { directory: string; profile: string; workspace: string; credential: string; credentialReference: string }
interface Scenario { name: string; file: string; extra: string[] }

async function prepare(metadata: Metadata): Promise<Fixture> {
    const directory = await mkdtemp(join(metadata.root, 'cli-agent-')), profile = join(directory, 'profile');
    const credential = await readFile(metadata.credentialFile, 'utf8'); let credentialReference = '';
    const workspace = join(directory, 'workspace'); await mkdir(workspace, { recursive: true });
    const backend = await openLocalFSBackend({ rootDir: profile, sidecarDir: join(profile, '_meta'), createDb: NodeSqliteSidecarDb.open });
    const driver = createNestOSNodeDriver(), runtime = await createApplicationRuntime({ backend, ownerKind: 'cli',
        remoteSourceProvider: driver, digitalTwinAutoStart: false });
    try {
        const nodeId = await runtime.projects.remoteMounts!.saveConnection({ name: 'CLI fixture', endpoint: metadata.endpoint }, credential);
        credentialReference = runtime.projects.remoteMounts!.connection(nodeId).credentialRef;
        const project = await runtime.projects.createRemote(metadata.project.name, null, nodeId,
            `/${metadata.project.alias}/${metadata.project.path}`, 'rw');
        for (const id of ['cli-native', 'remote-review']) await runtime.executionConnections.save({ id, name: id, kind: 'harness',
            nodeConnectionId: nodeId, projectId: project.project.id, profileId: metadata.profileId }, 0);
        await runtime.agentService.saveAgent({ id: 'cli-native-agent', name: 'CLI native Agent', type: 'agent', config: {},
            execution: { kind: 'harness', connectionId: 'cli-native' } });
    } finally { await runtime.dispose(); await driver.dispose(); }
    return { directory, profile, workspace, credential, credentialReference };
}

async function scenarios(directory: string): Promise<Scenario[]> {
    const flowFile = join(directory, 'remote-agent.flow'), paramsFile = join(directory, 'params.json');
    await writeFile(flowFile, JSON.stringify({ id: 'cli-native-flow', name: 'CLI native Flow', draftVersion: 1, updatedAt: 0,
        nodes: [{ id: 'remote', name: 'Remote', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
            config: { agentId: 'cli-native-agent', historyPolicy: 'none', instruction: 'Reply with the fixed fixture text' } }],
        edges: [], outputs: { result: { value: '${nodes.remote.outputs.result}' } } }, null, 2));
    await writeFile(paramsFile, JSON.stringify({ request: 'Reply with the fixed fixture text' }));
    return [{ name: 'agent-reference', file: flowFile, extra: [] },
        { name: 'shipped-inline-example', file: resolve('examples/remote-harness.flow'), extra: ['--params', paramsFile] }];
}

async function execute(f: Fixture, scenario: Scenario) {
    const args = ['--import', 'tsx', resolve('src/cli.ts'), 'run', '-f', scenario.file, '--profile', f.profile,
        '--set-home', f.workspace, '--headless', '--json', ...scenario.extra];
    const started = Date.now();
    const { stdout, stderr } = await promisify(execFile)(process.execPath, args, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, NESTOS_DIAGNOSTICS_DIR: join(f.directory, 'diagnostics'),
            [`NESTOS_REMOTE_${f.credentialReference.replace(/-/g, '_')}`]: f.credential } });
    expect(stdout).not.toContain(f.credential); expect(stderr).not.toContain(f.credential);
    await writeFile(join(f.directory, `${scenario.name}.stdout.jsonl`), stdout);
    await writeFile(join(f.directory, `${scenario.name}.stderr.log`), stderr);
    const store = new RunStore(join(f.profile, 'var/lib/cli-runs'));
    const run = (await store.list()).sort((a, b) => b.createdAt - a.createdAt)[0];
    expect(run.status, run.error).toBe('succeeded'); expect(run.flow?.definition.graph.nodes.some(node =>
        node.plugin === 'builtin.agent' && (node.config as Record<string, unknown>)?.execution !== undefined)).toBe(true);
    const output = await readFile(join(store.runDir(run.id), run.resultPath!), 'utf8');
    expect(output).toContain('Claude harness fixture reply');
    const artifact = JSON.parse(await readFile(join(store.runDir(run.id), 'artifacts/remote/result.json'), 'utf8'));
    expect(artifact.harness.text).toBe('Claude harness fixture reply');
    return { name: scenario.name, exitCode: 0, durationMs: Date.now() - started, runId: run.id,
        rootTaskId: run.rootTaskId, status: run.status, flowFile: scenario.file, output, nodeTaskIds: run.nodeTaskIds,
        nativeSessionId: artifact.harness.sessionId, nativeTurnId: artifact.harness.turnId, outputLength: artifact.harness.text.length,
        flowSha256: createHash('sha256').update(await readFile(scenario.file)).digest('hex') };
}

describe.skipIf(!metadataFile)('CLI .flow with a persisted remote Agent and installed native CLI', () => {
    it('binds config.agentId and the shipped inline execution example through the real command entry', async () => {
        const metadata: Metadata = JSON.parse(await readFile(resolve(metadataFile!), 'utf8')), f = await prepare(metadata);
        const reports: unknown[] = [];
        for (const scenario of await scenarios(f.directory)) {
            reports.push(await execute(f, scenario));
            await writeFile(join(f.directory, 'cli-report.json'), JSON.stringify({ schemaVersion: 1, cloudModel: false,
                nativeCLI: true, profile: f.profile, cases: reports }, null, 2) + '\n');
        }
    }, 180_000);
});
