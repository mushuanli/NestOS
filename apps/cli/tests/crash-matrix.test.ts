import { readFlowSchedulerCheckpoint } from '@itookit/llm-flow';
// @file: apps/cli/tests/crash-matrix.test.ts
// Program-level crashpoints: kill the real CLI process at a chosen point of the
// flow lifecycle (effect in flight, reply delivered but uncommitted, mid-loop,
// budget exhausted) and require `resume` to converge without duplicating work.
//
// The storage-level SIGKILL matrix lives in
// libraries/durable-kernel/tests/ipc.test.ts; this file covers the
// Flow/program layer: first step, loop iteration, route-free single node,
// terminal commit and budget accounting.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { SeqFileKernelStore } from '@itookit/durable-kernel';
import { CliStorageResolver, cliStorage, openProfileInspectionFs } from '../src/runtime';
import { listenForTest } from './listen';
import { cancelCommand, exportCommand, resumeCommand } from '../src/commands';

// A killed CLI cannot release its Session lease or the Run's scheduler lease; shorten
// both TTLs so recovery can take over within the test instead of waiting the
// production 60s / 30s.
process.env.NESTOS_SESSION_LEASE_TTL_MS = '1500';
process.env.NESTOS_SCHEDULER_LEASE_TTL_MS = '1500';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const CLI_CWD = fileURLToPath(new URL('../', import.meta.url));
const children: ChildProcess[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const roots: string[] = [];

it('keeps a lost media receipt indeterminate without replaying a paid request', async () => {
    const script = fileURLToPath(new URL('../scripts/verify-media-connections.mjs', import.meta.url));
    const result = await promisify(execFile)(process.execPath, [script, '--crash-only'], { timeout: 80_000, maxBuffer: 4_000_000 });
    const report = JSON.parse(result.stdout);
    roots.push(path.dirname(report.report));
    expect(report.crash).toMatchObject({ indeterminate: true, replayedRequests: 0 });
}, 90_000);

afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
    delete process.env.NESTOS_TEST_API_KEY;
});

/** Wait for the killed owner's Session and scheduler leases to expire before resuming. */
const settleLease = () => new Promise(resolve => setTimeout(resolve, 1800));

type KillPoint = { request: number; when: 'before-reply' | 'after-reply' };

/** Mock model server that SIGKILLs the CLI at the configured request. */
function crashingServer(killPoint: KillPoint, replies: (prompt: string, index: number) => string) {
    let child: ChildProcess | undefined;
    const prompts: string[] = [];
    const server = createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            const index = prompts.length + 1;
            const prompt = firstUser(body);
            prompts.push(prompt);
            if (index === killPoint.request && killPoint.when === 'before-reply') {
                child?.kill('SIGKILL');
                response.destroy();
                return;
            }
            reply(response, replies(prompt, index));
            if (index === killPoint.request && killPoint.when === 'after-reply') child?.kill('SIGKILL');
        });
    });
    return { server, prompts, attach: (value: ChildProcess) => { child = value; } };
}

function firstUser(body: string): string {
    const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }> };
    const message = parsed.messages?.find(item => item.role === 'user');
    return typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '');
}

function reply(response: ServerResponse, content: string): void {
    const chunk = (text: string, finish: string | null) => JSON.stringify({
        id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: finish }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${chunk(content, null)}\n\n`);
    response.write(`data: ${chunk('', 'stop')}\n\n`);
    response.end('data: [DONE]\n\n');
}

function startRun(configPath: string, stateDir: string, crash?: { tool: string; phase: string }): ChildProcess {
    const entry = crash ? fileURLToPath(new URL('./fixtures/memory-crash.ts', import.meta.url)) : CLI;
    const child = spawn(process.execPath, ['--import', 'tsx', entry, 'run', '-f', configPath,
        '--state-dir', stateDir, '--headless', '--json'], { cwd: CLI_CWD, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(crash ? { NESTOS_TEST_MEMORY_CRASH_TOOL: crash.tool, NESTOS_TEST_MEMORY_CRASH_PHASE: crash.phase } : {}) } });
    children.push(child);
    return child;
}

async function workspace(prefix: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    roots.push(root);
    return root;
}

async function latestRun(workspaceDir: string): Promise<string> {
    return (await readdir(path.join(workspaceDir, '.nestos', 'runs')))[0];
}

async function manifest(workspaceDir: string, runId: string): Promise<{
    status: string;
    rootTaskId?: string;
    nodeTaskIds?: Record<string, string>;
    blockedEffects?: Array<{ taskId: string; effectId: string }>;
}> {
    return JSON.parse(await readFile(path.join(workspaceDir, '.nestos', 'runs', runId, 'run.json'), 'utf8'));
}

// A killed process cannot prove whether its in-flight LLM call reached the provider, so
// the kernel reconciles the lost Effect to `indeterminate`. The Run must block on that
// decision instead of pretending the call failed; `--retry-indeterminate` is the host's
// authorization to replay the same logical Effect.
async function resumeWithReplay(runId: string, stateDir: string): Promise<number> {
    expect(await resumeCommand(runId, { stateDir, headless: true, json: true })).toBe(3);
    return resumeCommand(runId, { stateDir, headless: true, json: true, retryIndeterminate: true });
}

async function storedMemory(stateDir: string, runId: string) {
    const inspection = await openProfileInspectionFs(stateDir);
    try {
        const resolver = new CliStorageResolver(inspection.fs), binding = await resolver.resolve(cliStorage(runId));
        const store = new SeqFileKernelStore(binding, reference => resolver.resolve(reference));
        const tasks = await store.listTasks(binding);
        const effects = tasks.flatMap(task => Object.values(task.effects)).filter(effect => effect.request.kind === 'tool.call');
        return { memory: await store.getShared(binding, 'memory.entries.["agent","project"]'), effects };
    } finally { await inspection.dispose(); }
}

async function storedTasks(stateDir: string, runId: string) {
    const inspection = await openProfileInspectionFs(stateDir);
    try {
        const resolver = new CliStorageResolver(inspection.fs), binding = await resolver.resolve(cliStorage(runId));
        return await new SeqFileKernelStore(binding, reference => resolver.resolve(reference)).listTasks(binding);
    } finally { await inspection.dispose(); }
}

function memoryReply(response: ServerResponse, tool?: string): void {
    const args = { scope: 'project', entryId: 'note', ...(tool === 'memory_write' ? { content: 'durable memory' } : {}) };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'mock', object: 'chat.completion', created: 1, model: 'mock-model',
        choices: [{ index: 0, message: tool ? { role: 'assistant', content: '', tool_calls: [{ id: tool, type: 'function',
            function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'done' },
        finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
}

it.each([
    { tool: 'memory_write', phase: 'before' }, { tool: 'memory_write', phase: 'after' },
    { tool: 'memory_remove', phase: 'before' }, { tool: 'memory_remove', phase: 'after' },
])('blocks an unreceipted $tool killed $phase its mutation until explicit replay', async crash => {
    let requests = 0;
    const server = createServer((request, response) => {
        request.resume(); request.on('end', () => {
            requests++;
            memoryReply(response, requests === 1 ? 'memory_write'
                : crash.tool === 'memory_remove' && requests === 2 ? 'memory_remove' : undefined);
        });
    });
    servers.push(server);
    const port = await listenForTest(server), root = await workspace('nestos-memory-unreceipted-');
    const stateDir = path.join(root, '.nestos'), configPath = path.join(root, 'mindos.yml');
    const config = parse(singleNodeConfig(port));
    Object.assign(config.agents[0], { tools: ['memory_write', 'memory_remove'], stream: false, approval: 'none',
        memory_policy: { namespace_id: 'agent', read_scopes: ['project'], write_scopes: ['project'] } });
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    await writeFile(configPath, stringify(config));
    const child = startRun(configPath, stateDir, crash);
    let stderr = ''; child.stderr?.on('data', data => { stderr += data; });
    expect(await once(child, 'exit'), stderr).toEqual([null, 'SIGKILL']);
    const runId = await latestRun(root);
    await settleLease();
    const killed = await storedMemory(stateDir, runId);
    const present = crash.tool === 'memory_write' ? crash.phase === 'after' : crash.phase === 'before';
    expect(killed.memory?.value ?? []).toEqual(present ? [expect.objectContaining({ content: 'durable memory' })] : []);
    expect(killed.effects.filter(effect => effect.status === 'leased')).toHaveLength(1);
    const callsAtCrash = requests;
    expect(await resumeCommand(runId, { stateDir, headless: true, json: true })).toBe(3);
    expect(requests).toBe(callsAtCrash);
    const blocked = await storedMemory(stateDir, runId);
    expect(blocked.memory).toEqual(killed.memory);
    const uncertain = blocked.effects.filter(effect => effect.status === 'indeterminate');
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0].error?.code).toBe('TOOL_INDETERMINATE');
    expect(await resumeCommand(runId, { stateDir, headless: true, json: true, retryIndeterminate: true })).toBe(0);
    expect(requests).toBe(callsAtCrash + 1);
    const recovered = await storedMemory(stateDir, runId);
    expect(recovered.memory?.value).toEqual(crash.tool === 'memory_write'
        ? [expect.objectContaining({ content: 'durable memory' })] : []);
    expect(recovered.effects.every(effect => effect.status === 'succeeded')).toBe(true);
    expect(await manifest(root, runId)).toMatchObject({ status: 'succeeded' });
}, 40_000);

it.each(['write', 'remove'] as const)('preserves a committed memory %s across CLI SIGKILL and resume without replay', async operation => {
    const requests: any[] = [];
    const killRequest = operation === 'write' ? 2 : 3;
    let child: ChildProcess;
    const server = createServer((request, response) => {
        let body = ''; request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            requests.push(JSON.parse(body));
            if (requests.length === killRequest) { child.kill('SIGKILL'); response.destroy(); return; }
            memoryReply(response, requests.length === 1 ? 'memory_write'
                : operation === 'remove' && requests.length === 2 ? 'memory_remove' : undefined);
        });
    });
    servers.push(server);
    const port = await listenForTest(server), root = await workspace('nestos-crash-memory-');
    const stateDir = path.join(root, '.nestos'), configPath = path.join(root, 'mindos.yml');
    const config = parse(singleNodeConfig(port));
    Object.assign(config.agents[0], { tools: ['memory_write', 'memory_remove'], stream: false, approval: 'none',
        memory_policy: { namespace_id: 'agent', read_scopes: ['project'], write_scopes: ['project'] } });
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    await writeFile(configPath, stringify(config));
    child = startRun(configPath, stateDir);
    const [code, signal] = await once(child, 'exit');
    expect([code, signal]).toEqual([null, 'SIGKILL']);
    const runId = await latestRun(root);
    await settleLease();
    const committed = await storedMemory(stateDir, runId);
    expect(committed.memory?.value).toEqual(operation === 'write'
        ? [expect.objectContaining({ entryId: 'note', content: 'durable memory' })] : []);
    expect(committed.effects).toHaveLength(killRequest - 1);
    for (const effect of committed.effects) expect(effect).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    const toolResults = requests.at(-1).messages.filter((message: any) => message.role === 'tool');
    expect(toolResults).toHaveLength(killRequest - 1);
    for (const result of toolResults) expect(result.content).toContain('success');
    expect(await resumeCommand(runId, { stateDir, headless: true, json: true })).toBe(3);
    expect(requests).toHaveLength(killRequest);
    expect(await storedMemory(stateDir, runId)).toEqual(committed);
    expect(await resumeCommand(runId, { stateDir, headless: true, json: true, retryIndeterminate: true })).toBe(0);
    expect(requests).toHaveLength(killRequest + 1);
    // Compare the entire versioned record: an unconditional duplicate write would change it.
    expect(await storedMemory(stateDir, runId)).toEqual(committed);
    expect(await manifest(root, runId)).toMatchObject({ status: 'succeeded' });
}, 40_000);

it('recovers a run killed while the first Effect is in flight', async () => {
    const crash = crashingServer({ request: 1, when: 'before-reply' }, () => 'done');
    const port = await listenForTest(crash.server);
    servers.push(crash.server);

    const root = await workspace('nestos-crash-effect-');
    const stateDir = path.join(root, '.nestos');
    const configPath = path.join(root, 'mindos.yml');
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    await writeFile(configPath, singleNodeConfig(port), 'utf8');

    const child = startRun(configPath, stateDir);
    crash.attach(child);
    const [code, signal] = await once(child, 'exit');
    expect(signal).toBe('SIGKILL');
    expect(code).toBeNull();

    const runId = await latestRun(root);
    const killed = await manifest(root, runId);
    expect(killed.status).not.toBe('succeeded');
    // Whether the monitor projected node ids before the kill is a race, not an invariant:
    // both the start and the resume path always run `monitor()` (the non-interactive flag
    // only skips the UI), so a tick can land before the crash. Only assert that whatever
    // was recorded is coherent; `export` must find the node Tasks through the Session
    // either way, which the assertions below cover.
    for (const [nodeId, taskId] of Object.entries(killed.nodeTaskIds ?? {})) {
        expect(nodeId).toBe('finish');
        expect(taskId).toMatch(/^task_/);
    }

    await settleLease();
    // Export holds a Session lease itself, so it also waits for the killed owner.
    const exportPath = path.join(root, 'crash-export.json');
    expect(await exportCommand(runId, { stateDir, headless: true, json: true, out: exportPath })).toBe(0);
    const exported = JSON.parse(await readFile(exportPath, 'utf8')) as {
        nodes: Array<{ nodeId: string; taskId: string; transcript?: unknown; error?: string }>;
    };
    expect(exported.nodes.map(node => node.nodeId)).toEqual(['finish']);
    expect(exported.nodes[0]?.transcript ?? exported.nodes[0]?.error).toBeTruthy();

    // The Run root is persisted before the first node runs, so a crash at any later
    // point stays resumable instead of restarting the graph.
    expect(await resumeCommand(runId, { stateDir, headless: true, json: true })).toBe(3);
    const waiting = await manifest(root, runId);
    expect(waiting.rootTaskId).toBeTruthy();
    expect(waiting.blockedEffects?.length).toBeGreaterThan(0);

    expect(await resumeCommand(runId, { stateDir, headless: true, json: true, retryIndeterminate: true })).toBe(0);
    const final = await manifest(root, runId);
    expect(final).toMatchObject({ status: 'succeeded' });
    expect(final.blockedEffects).toBeUndefined();
    expect(await readFile(path.join(stateDir, 'runs', runId, 'result.txt'), 'utf8')).toBe('done');
    expect(crash.prompts.length).toBeGreaterThanOrEqual(2);
}, 40_000);

it('cancels a Run blocked on an indeterminate Effect and refuses to replay it', async () => {
    const crash = crashingServer({ request: 1, when: 'before-reply' }, () => 'done');
    const port = await listenForTest(crash.server);
    servers.push(crash.server);

    const root = await workspace('nestos-crash-cancel-');
    const stateDir = path.join(root, '.nestos');
    const configPath = path.join(root, 'mindos.yml');
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    await writeFile(configPath, singleNodeConfig(port), 'utf8');

    const child = startRun(configPath, stateDir);
    crash.attach(child);
    expect(await once(child, 'exit')).toEqual([null, 'SIGKILL']);
    const runId = await latestRun(root);
    await settleLease();

    expect(await resumeCommand(runId, { stateDir, headless: true, json: true })).toBe(3);
    const blocked = await storedTasks(stateDir, runId);
    expect(blocked.flatMap(task => Object.values(task.effects)).filter(effect => effect.status === 'indeterminate')).toHaveLength(1);
    expect(crash.prompts).toHaveLength(1);

    // The killed host left an Effect whose outcome cannot be proven. `nestos cancel` is
    // the documented alternative to authorizing a replay, and it must converge durably:
    // the old owner is dead and its leases have expired before the new host cancels.
    expect(await cancelCommand(runId, { stateDir, headless: true, json: true })).toBe(0);
    expect(await manifest(root, runId)).toMatchObject({ status: 'cancelled' });
    const callsAfterCancel = crash.prompts.length;

    // A cancelled Run is terminal: resuming must not replay the blocked Effect.
    expect(await resumeCommand(runId, { stateDir, headless: true, json: true })).toBe(1);
    expect(crash.prompts.length).toBe(callsAfterCancel);
    expect((await storedTasks(stateDir, runId)).map(task => task.id).sort()).toEqual(blocked.map(task => task.id).sort());
    expect(await manifest(root, runId)).toMatchObject({ status: 'cancelled' });
}, 40_000);

it('does not re-apply a graph patch when replaying a crashed spawned node', async () => {
    const crash = crashingServer({ request: 1, when: 'before-reply' }, () => 'SPAWNED A');
    const port = await listenForTest(crash.server);
    servers.push(crash.server);

    const root = await workspace('nestos-crash-spawn-');
    const stateDir = path.join(root, '.nestos');
    const configPath = path.join(root, 'mindos.yml');
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    await writeFile(configPath, spawnConfig(port), 'utf8');

    const child = startRun(configPath, stateDir);
    crash.attach(child);
    expect(await once(child, 'exit')).toEqual([null, 'SIGKILL']);
    const runId = await latestRun(root);
    await settleLease();

    const before = await storedTasks(stateDir, runId);
    expect(before.flatMap(task => Object.values(task.effects)).filter(effect => effect.status === 'leased')).toHaveLength(1);

    // The patch was applied (the spawned node Task exists) before the kill. Resuming must
    // replay only the blocked model Effect, not apply the patch again.
    expect(await resumeWithReplay(runId, stateDir)).toBe(0);
    const final = await manifest(root, runId);
    expect(final).toMatchObject({ status: 'succeeded' });
    const recovered = await storedTasks(stateDir, runId);
    expect(recovered.map(task => task.id).sort()).toEqual(before.map(task => task.id).sort());
    expect(recovered.every(task => task.status === 'succeeded')).toBe(true);
    // One request was killed and one replayed for the same persistent Task set.
    expect(crash.prompts).toHaveLength(2);
    expect(crash.prompts.some(body => body.includes('动态任务 A'))).toBe(true);
}, 40_000);

it('reconciles a run killed after the reply was delivered but before it committed', async () => {
    const crash = crashingServer({ request: 1, when: 'after-reply' }, () => 'done');
    const port = await listenForTest(crash.server);
    servers.push(crash.server);

    const root = await workspace('nestos-crash-commit-');
    const stateDir = path.join(root, '.nestos');
    const configPath = path.join(root, 'mindos.yml');
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    await writeFile(configPath, singleNodeConfig(port), 'utf8');

    const child = startRun(configPath, stateDir);
    crash.attach(child);
    await once(child, 'exit');
    const runId = await latestRun(root);
    expect((await manifest(root, runId)).status).not.toBe('succeeded');

    await settleLease();
    expect(await resumeWithReplay(runId, stateDir)).toBe(0);
    expect(await manifest(root, runId)).toMatchObject({ status: 'succeeded' });
    expect(await readFile(path.join(stateDir, 'runs', runId, 'result.txt'), 'utf8')).toBe('done');
}, 40_000);

it('continues a loop from the last committed iteration after a kill', async () => {
    const crash = crashingServer({ request: 3, when: 'after-reply' },
        (prompt, index) => prompt.includes('循环入口') ? `entry-${index}` : `body-${index}`);
    const port = await listenForTest(crash.server);
    servers.push(crash.server);

    const root = await workspace('nestos-crash-loop-');
    const stateDir = path.join(root, '.nestos');
    const configPath = path.join(root, 'mindos.yml');
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    await writeFile(configPath, loopConfig(port), 'utf8');

    const child = startRun(configPath, stateDir);
    crash.attach(child);
    await once(child, 'exit');
    const runId = await latestRun(root);
    expect(crash.prompts.length).toBeGreaterThanOrEqual(2);

    await settleLease();
    expect(await resumeWithReplay(runId, stateDir)).toBe(0);
    expect(await manifest(root, runId)).toMatchObject({ status: 'succeeded' });
    // max_iterations=3: the loop stops after three committed iterations. The iteration
    // in flight at the kill is replayed once, so the entry node is called at most four
    // times while the body node — never in flight — is called exactly three times.
    const entryCalls = crash.prompts.filter(prompt => prompt.includes('循环入口')).length;
    const bodyCalls = crash.prompts.filter(prompt => prompt.includes('循环体')).length;
    expect(entryCalls).toBeLessThanOrEqual(4);
    expect(bodyCalls).toBe(3);
    // The result is the last body call's reply, proving the resumed Run continued the
    // loop instead of restarting it from iteration one.
    const lastBodyCall = crash.prompts.reduce((last, prompt, index) =>
        prompt.includes('循环体') ? index : last, -1);
    expect(await readFile(path.join(stateDir, 'runs', runId, 'result.txt'), 'utf8'))
        .toBe(`body-${lastBodyCall + 1}`);
}, 60_000);

it('preserves budget accounting across a crash and resume', async () => {
    const crash = crashingServer({ request: 2, when: 'after-reply' },
        (prompt, index) => prompt.includes('循环入口') ? `entry-${index}` : `body-${index}`);
    const port = await listenForTest(crash.server);
    servers.push(crash.server);

    const root = await workspace('nestos-crash-budget-');
    const stateDir = path.join(root, '.nestos');
    const configPath = path.join(root, 'mindos.yml');
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    // Each reply reports 3 tokens; a 9-token budget on the entry node allows three
    // iterations. A resumed run must not restart the counter.
    await writeFile(configPath, loopConfig(port, { budget: 9 }), 'utf8');

    const child = startRun(configPath, stateDir);
    crash.attach(child);
    await once(child, 'exit');
    const runId = await latestRun(root);

    await settleLease();
    const code = await resumeWithReplay(runId, stateDir);
    const final = await manifest(root, runId);
    expect(['succeeded', 'failed']).toContain(final.status);
    expect(code === 0 || code === 1).toBe(true);
    expect(crash.prompts.filter(prompt => prompt.includes('循环入口')).length).toBeLessThanOrEqual(4);
}, 60_000);

function startSchedulerCrash(configPath: string, stateDir: string, node: string, completed = ''): ChildProcess {
    const entry = fileURLToPath(new URL('./fixtures/scheduler-crash.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', entry, 'run', '-f', configPath,
        '--state-dir', stateDir, '--headless', '--json'], { cwd: CLI_CWD, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NESTOS_TEST_SUBMIT_NODE: node,
            NESTOS_TEST_COMPLETED_INSTANCE: completed } });
    children.push(child);
    child.stdout?.resume();
    return child;
}

async function storedCheckpoint(stateDir: string, runId: string, rootId: string) {
    const inspection = await openProfileInspectionFs(stateDir);
    try {
        const resolver = new CliStorageResolver(inspection.fs), binding = await resolver.resolve(cliStorage(runId));
        const store = new SeqFileKernelStore(binding, reference => resolver.resolve(reference));
        return (await readFlowSchedulerCheckpoint({ getShared: key => store.getShared(binding, key) }, rootId))!;
    } finally { await inspection.dispose(); }
}

it.each(['root-created', 'capability-bound', 'task-started', 'graph-patched', 'delegation-joined', 'finish', 'finish:delegate:1:0', 'finish:delegate:1:1', 'delegation-inflight'])(
    'recovers the scheduler SIGKILL window %s', async node => {
        const inflight = node === 'delegation-inflight';
        const patched = node === 'graph-patched';
        const joined = node === 'delegation-joined';
        const rootBoundary = node === 'root-created' || joined;
        const delegation = node.includes(':delegate:') || inflight || joined;
        let child: ChildProcess;
        const prompts: string[] = [];
        const server = createServer((request, response) => {
            let body = ''; request.on('data', chunk => { body += chunk; });
            request.on('end', () => {
                const prompt = firstUser(body); prompts.push(prompt);
                const parent = !prompt.includes('Handle one payload');
                if (inflight && !parent && prompts.length === 2) {
                    child.kill('SIGKILL'); response.destroy(); return;
                }
                const message = delegation && parent ? { role: 'assistant', content: '', tool_calls: [{
                    id: 'delegate-one', type: 'function', function: { name: 'delegate_tasks',
                        arguments: JSON.stringify({ items: [{ id: 1 }, { id: 2 }] }) },
                }] } : { role: 'assistant', content: 'done' };
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ choices: [{ index: 0, message,
                    finish_reason: delegation && parent ? 'tool_calls' : 'stop' }], usage: { total_tokens: 3 } }));
            });
        });
        servers.push(server);
        const port = await listenForTest(server), root = await workspace('nestos-submit-gap-');
        const stateDir = path.join(root, '.nestos'), configPath = path.join(root, 'mindos.yml');
        const config = parse(singleNodeConfig(port));
        Object.assign(config.agents[0], { stream: false, approval: 'none' });
        if (delegation) config.tasks[0].delegation = { agent: 'worker', instruction: 'Handle one payload',
            max_tasks: 2, max_concurrency: 1 };
        if (patched) {
            config.tasks = [{ id: 'dispatcher', description: 'Dispatch dynamic task', spawn: { tasks: [{ id: 'worker_a', agent: 'worker', description: 'Dynamic child', outputs: { result: 'text' } }],
                edges: [{ from: 'dispatcher', to: 'worker_a' }] }, outputs: { result: 'text' } }];
            config.result = { task: 'dispatcher', output: 'result' };
        }
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, stringify(config));
        child = startSchedulerCrash(configPath, stateDir, inflight ? '' : node);
        let stderr = ''; child.stderr?.on('data', chunk => { stderr += chunk; });
        expect(await once(child, 'exit'), stderr).toEqual([null, 'SIGKILL']);
        const runId = await latestRun(root);
        await settleLease();
        const before = await storedTasks(stateDir, runId);
        const submittedNode = patched ? 'dispatcher' : inflight ? 'finish:delegate:1:0'
            : ['capability-bound', 'task-started'].includes(node) ? 'finish' : node;
        const submitted = before.find(task => rootBoundary ? task.labels?.kind === 'flow-root' : task.labels?.flowNodeId === submittedNode)!;
        expect(submitted).toBeDefined();
        const rootId = before.find(task => task.labels?.kind === 'flow-root')!.id;
        const checkpoint = node === 'root-created'
            ? (submitted.input as { initialScheduler: Awaited<ReturnType<typeof storedCheckpoint>> }).initialScheduler
            : await storedCheckpoint(stateDir, runId, rootId);
        if (!inflight && !patched) expect(checkpoint.instances.flatMap(([, ids]) => ids)).not.toContain(submitted.id);
        const completed = before.filter(task => task.status === 'succeeded');
        const callsAtCrash = prompts.length;
        if (inflight) {
            expect(await resumeCommand(runId, { stateDir, headless: true, json: true })).toBe(3);
            expect(prompts).toHaveLength(callsAtCrash);
        }
        expect(await resumeCommand(runId, { stateDir, headless: true, json: true, retryIndeterminate: inflight })).toBe(0);
        const after = await storedTasks(stateDir, runId);
        expect(after.filter(task => rootBoundary ? task.labels?.kind === 'flow-root' : task.labels?.flowNodeId === submittedNode).map(task => task.id)).toEqual([submitted.id]);
        for (const task of completed) expect(after.find(item => item.id === task.id)).toEqual(task);
        expect(after).toHaveLength(patched ? 3 : delegation ? 4 : 2);
        expect(prompts).toHaveLength(inflight ? 4 : delegation ? 3 : 1);
        if (joined) expect(prompts.length).toBe(callsAtCrash);
        else expect(prompts.length).toBeGreaterThan(callsAtCrash);
        expect(await manifest(root, runId)).toMatchObject({ status: 'succeeded', rootTaskId: rootId });
    }, 40_000,
);

it('does not replay a completed loop iteration whose checkpoint was killed before commit', async () => {
    const model = crashingServer({ request: -1, when: 'before-reply' }, (_prompt, index) => `answer-${index}`);
    servers.push(model.server);
    const port = await listenForTest(model.server), root = await workspace('nestos-loop-checkpoint-');
    const stateDir = path.join(root, '.nestos'), configPath = path.join(root, 'mindos.yml');
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    await writeFile(configPath, loopConfig(port));
    const child = startSchedulerCrash(configPath, stateDir, '', 'entry#2');
    let stderr = ''; child.stderr?.on('data', chunk => { stderr += chunk; });
    expect(await once(child, 'exit'), stderr).toEqual([null, 'SIGKILL']);
    const runId = await latestRun(root);
    await settleLease();
    const before = await storedTasks(stateDir, runId);
    const rootId = before.find(task => task.labels?.kind === 'flow-root')!.id;
    const checkpoint = await storedCheckpoint(stateDir, runId, rootId);
    expect(checkpoint.completed).toContain('entry#1');
    expect(checkpoint.completed).not.toContain('entry#2');
    const entries = before.filter(task => task.labels?.flowNodeId === 'entry');
    expect(entries).toHaveLength(2);
    expect(entries.every(task => task.status === 'succeeded')).toBe(true);
    expect(await resumeCommand(runId, { stateDir, headless: true, json: true })).toBe(0);
    const after = await storedTasks(stateDir, runId);
    for (const task of before.filter(task => task.status === 'succeeded')) {
        expect(after.find(item => item.id === task.id)).toEqual(task);
    }
    expect(after.filter(task => task.labels?.flowNodeId === 'entry')).toHaveLength(3);
    expect(model.prompts.filter(prompt => prompt.includes('循环入口'))).toHaveLength(3);
    expect(model.prompts.filter(prompt => prompt.includes('循环体'))).toHaveLength(3);
    expect(await manifest(root, runId)).toMatchObject({ status: 'succeeded' });
}, 40_000);

// ── Config builders ─────────────────────────────────────────────────────────

function header(port: number, name: string): string {
    return `version: 1
name: ${name}
goal: Crash matrix
workspace:
  root: .
providers:
  - id: mock
    implementation: openai-compatible
    base_url: http://127.0.0.1:${port}
    default_path: /v1/chat/completions
    api_key_env: NESTOS_TEST_API_KEY
    models:
      - id: mock-model
connections:
  - id: default
    provider: mock
    tiers:
      standard: mock-model
agents:
  - id: worker
    connection: default
`;
}

function singleNodeConfig(port: number): string {
    return `${header(port, 'single')}tasks:
  - id: finish
    agent: worker
    description: Return done
    outputs:
      result: text
result:
  task: finish
  output: result
sandbox:
  mode: native
`;
}

function spawnConfig(port: number): string {
    return `${header(port, 'spawn')}tasks:
  - id: dispatcher
    description: 派发动态任务
    spawn:
      tasks:
        - id: worker_a
          agent: worker
          description: 动态任务 A
          outputs:
            result: text
      edges:
        - from: dispatcher
          to: worker_a
    outputs:
      result: text
result:
  task: dispatcher
  output: result
sandbox:
  mode: native
`;
}

function loopConfig(port: number, options: { budget?: number } = {}): string {
    return `${header(port, 'loop')}tasks:
  - id: entry
    agent: worker
    description: 循环入口
    max_iterations: 3
${options.budget === undefined ? '' : `    budget:
      tokens: ${options.budget}
`}    outputs:
      result: text
  - id: body
    agent: worker
    description: 循环体
    depends_on: [entry]
    outputs:
      result: text
  - id: router
    route:
      rules:
        # The mock always answers, so the body output always exists and the back edge
        # keeps looping until max_iterations stops the entry node.
        - when:
            exists: true
          then: entry
      default: exit
    depends_on: [body]
    inputs:
      input: \${tasks.body.outputs.result}
  - id: exit
    agent: worker
    description: 退出循环
    outputs:
      result: text
result:
  task: body
  output: result
sandbox:
  mode: native
`;
}
