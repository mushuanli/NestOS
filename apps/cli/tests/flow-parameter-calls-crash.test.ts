import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { SeqFileKernelStore } from '@itookit/durable-kernel';
import { CliStorageResolver, cliStorage, openProfileInspectionFs } from '../src/runtime';
import type { RunManifest } from '../src/types';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const CLI_CWD = fileURLToPath(new URL('../', import.meta.url));
const roots: string[] = [];
interface CliProcess {
    child: ChildProcess;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    stdout(): string;
    stderr(): string;
}
const processes: CliProcess[] = [];
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

afterEach(async () => {
    for (const process of processes.splice(0)) {
        if (alive(process.child)) process.child.kill('SIGKILL');
        await process.exited;
    }
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function alive(child: ChildProcess): boolean { return child.exitCode === null && child.signalCode === null; }

function cli(stateDir: string, args: string[], interactive = false): CliProcess {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args, '--profile', stateDir, '--state-dir', stateDir,
        ...interactive ? [] : ['--headless', '--json']], { cwd: CLI_CWD, stdio: ['pipe', 'pipe', 'pipe'], env: {
        ...process.env, MINDOS_TOOL_MODULES: '[]', MINDOS_SESSION_LEASE_TTL_MS: '1500', MINDOS_SCHEDULER_LEASE_TTL_MS: '1500',
        MINDOS_SESSION_LEASE_SKEW_MS: '0', MINDOS_SCHEDULER_LEASE_SKEW_MS: '0',
    } });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const handle = { child, exited, stdout: () => stdout, stderr: () => stderr };
    processes.push(handle); return handle;
}

async function command(stateDir: string, args: string[], expected = 0) {
    const process = cli(stateDir, args);
    expect(await process.exited, process.stderr()).toEqual({ code: expected, signal: null });
}

async function setup() {
    const root = await mkdtemp(path.join(tmpdir(), 'flow-parameter-calls-crash-')); roots.push(root);
    for (const id of ['parameter-record', 'parameter-calls']) await copyFile(
        fileURLToPath(new URL(`../examples/${id}.flow`, import.meta.url)), path.join(root, `${id}.flow`));
    const childPath = path.join(root, 'parameter-record.flow');
    const child = JSON.parse(await readFile(childPath, 'utf8'));
    child.nodes.push({ id: 'review', name: 'Review ${param.source}', plugin: 'builtin.human', pluginVersion: '1.0.0',
        inputs: {}, config: { requestId: 'confirm', prompt: 'Review ${param.source}' } });
    child.edges.push({ id: 'record-review', from: 'record', to: 'review', kind: 'control' });
    await writeFile(childPath, JSON.stringify(child));
    return { root, stateDir: path.join(root, 'profile'), childPath, file: path.join(root, 'parameter-calls.flow') };
}

async function manifest(stateDir: string): Promise<RunManifest | undefined> {
    const ids = await readdir(path.join(stateDir, 'runs')).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []; throw error;
    });
    if (!ids.length) return undefined;
    return JSON.parse(await readFile(path.join(stateDir, 'runs', ids[0], 'run.json'), 'utf8'));
}

async function inspect(stateDir: string, run: RunManifest) {
    const inspection = await openProfileInspectionFs(stateDir);
    try {
        const resolver = new CliStorageResolver(inspection.fs), binding = await resolver.resolve(cliStorage(run.id));
        const store = new SeqFileKernelStore(binding, reference => resolver.resolve(reference));
        const checkpoint = await store.getShared(binding, `flow.run.${run.rootTaskId}.scheduler`);
        return { tasks: await store.listTasks(binding), checkpoint: checkpoint?.value as {
            instances: [string, string[]][]; completed: string[];
        } | undefined };
    } finally { await inspection.dispose(); }
}

async function stableWaiting(stateDir: string, process: CliProcess) {
    const deadline = Date.now() + 15_000;
    let previous = '';
    while (Date.now() < deadline) {
        if (!alive(process.child)) throw new Error(`CLI exited before durable waiting: ${process.stderr()}`);
        const run = await manifest(stateDir);
        if (run?.status === 'waiting' && run.pendingInteractions.length === 1 && process.stdout().includes('Review first document')) {
            const state = await inspect(stateDir, run), checkpoint = state.checkpoint;
            const ids = checkpoint?.instances.flatMap(([, values]) => values) ?? [];
            const ready = checkpoint && ids.includes(run.pendingInteractions[0].taskId)
                && state.tasks.some(task => task.status === 'succeeded')
                && Object.values(run.nodeTaskIds).every(id => ids.includes(id));
            const signature = ready ? JSON.stringify(checkpoint) : '';
            if (signature && signature === previous) return { run, ...state };
            previous = signature;
        }
        await delay(100);
    }
    throw new Error('CLI did not reach a stable scheduler checkpoint with one pending parameter call');
}

it('recovers serial parameter calls after real CLI SIGKILL without replacing completed tasks', async () => {
    const fixture = await setup(), running = cli(fixture.stateDir, ['run', '-f', fixture.file], true);
    const before = await stableWaiting(fixture.stateDir, running);
    expect(alive(running.child)).toBe(true);
    expect(running.child.kill('SIGKILL')).toBe(true);
    expect(await running.exited).toEqual({ code: null, signal: 'SIGKILL' });
    const completed = before.tasks.filter(task => task.status === 'succeeded');
    expect(completed.length).toBeGreaterThan(0);
    // Recovery must use the frozen child definition, including both named arguments.
    await writeFile(fixture.childPath, JSON.stringify({ id: 'changed-after-crash' }));
    await delay(1800);
    await command(fixture.stateDir, ['resume', before.run.id], 3);
    for (const source of ['first document', 'second document']) {
        const waiting = (await manifest(fixture.stateDir))!;
        expect(waiting.pendingInteractions).toHaveLength(1);
        expect(waiting.pendingInteractions[0].prompt).toBe('Review ' + source);
        await command(fixture.stateDir, ['respond', waiting.id, waiting.pendingInteractions[0].interactionId, '--value', '"approved"']);
        await command(fixture.stateDir, ['resume', waiting.id], source === 'first document' ? 3 : 0);
    }
    const finished = (await manifest(fixture.stateDir))!, after = await inspect(fixture.stateDir, finished);
    expect(finished.status).toBe('succeeded');
    expect(JSON.parse(await readFile(path.join(fixture.stateDir, 'runs', finished.id, 'result.json'), 'utf8'))).toEqual({ results: [
        { result: { source: 'first document', language: 'zh-CN', detail: 2 } },
        { result: { source: 'second document', language: 'en', detail: 2 } },
    ] });
    for (const task of completed) expect(after.tasks.find(value => value.id === task.id)).toEqual(task);
    for (const [id, taskId] of Object.entries(before.run.nodeTaskIds)) expect(finished.nodeTaskIds[id]).toBe(taskId);
    expect(after.tasks.flatMap(task => Object.values(task.effects))).toEqual([]);
    await command(fixture.stateDir, ['resume', finished.id]);
    expect((await inspect(fixture.stateDir, finished)).tasks.map(task => task.id).sort()).toEqual(after.tasks.map(task => task.id).sort());
    expect((await manifest(fixture.stateDir))!.nodeTaskIds).toEqual(finished.nodeTaskIds);
}, 60_000);
