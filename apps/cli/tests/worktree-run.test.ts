// @file: apps/cli/tests/worktree-run.test.ts
// P1-03 host assembly: the CLI builds a Git worktree workspace manager from
// `runtime.workspace.mode: worktree`, so an isolated Run executes the node inside the
// worktree (agent cwd), never in the base repository, and a crashed host re-attaches the
// recorded worktree on `resume` instead of preparing a second one.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { access, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { listenForTest } from './listen';
import { resumeCommand } from '../src/commands';

// A killed CLI cannot release its Session or scheduler lease; shorten both TTLs the same
// way the crash matrix does so recovery happens inside the test.
process.env.NESTOS_SESSION_LEASE_TTL_MS = '1500';
process.env.NESTOS_SCHEDULER_LEASE_TTL_MS = '1500';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const CLI_CWD = fileURLToPath(new URL('../', import.meta.url));
const children: ChildProcess[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const roots: string[] = [];

afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
    delete process.env.NESTOS_TEST_API_KEY;
});

function git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
            if (error) reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`));
            else resolve(stdout);
        });
    });
}

async function initRepo(root: string): Promise<void> {
    await git(root, ['init', '-b', 'main']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await git(root, ['config', 'user.name', 'Nestos Test']);
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'init']);
}

/** Registered worktrees, canonicalized so `git`'s own path spelling cannot fail the test. */
async function listedWorktrees(root: string): Promise<string[]> {
    const lines = (await git(root, ['worktree', 'list', '--porcelain'])).split('\n')
        .filter(line => line.startsWith('worktree '));
    return Promise.all(lines.map(line => realpath(line.slice('worktree '.length))));
}

/**
 * Model server. `writes` makes the first round call Bash, so the worktree ends up dirty;
 * otherwise the node only produces text and the worktree stays clean.
 */
function modelServer(writes: boolean, tool: 'Bash' | 'Write' = 'Bash'): ReturnType<typeof createServer> {
    let calls = 0;
    return createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            prompts.push(body);
            const call = calls++;
            if (writes && call === 0) {
                const toolCall = tool === 'Bash'
                    // `marker.txt` is relative: it lands in whatever cwd the node was given.
                    ? { name: 'Bash', arguments: JSON.stringify({ command: 'printf worktree > marker.txt' }) }
                    // Absolute VFS path: the mount decides which host directory is edited.
                    : { name: 'Write', arguments: JSON.stringify({ file_path: '/workspace/written.txt', content: 'from vfs' }) };
                sendJson(response, {
                    role: 'assistant', content: null,
                    tool_calls: [{ id: 'call_1', type: 'function', function: toolCall }],
                }, 'tool_calls');
                return;
            }
            sendJson(response, { role: 'assistant', content: 'done' }, 'stop');
        });
    });
}

/** Raw model request bodies, for asserting what the agent was told about its workspace. */
const prompts: string[] = [];

function sendJson(response: ServerResponse, message: Record<string, unknown>, finish: string): void {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
        id: 'mock', object: 'chat.completion', created: 1, model: 'mock-model',
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));
}

function config(port: number, workspaceBlock: string, tool = 'Bash'): string {
    return `version: 1
name: worktree
goal: Run isolated
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
    stream: false
    approval: none
    tools: [${tool}]
tasks:
  - id: finish
    agent: worker
    description: Write a marker
    workspace_access: write
    outputs:
      result: text
result:
  task: finish
  output: result
runtime:
  workspace:
    mode: worktree
${workspaceBlock}sandbox:
  mode: native
`;
}

async function setup(writes: boolean, workspaceBlock = '', tool: 'Bash' | 'Write' = 'Bash'): Promise<{
    root: string; stateDir: string; configPath: string; canonical: (target: string) => Promise<string>;
}> {
    prompts.length = 0;
    const server = modelServer(writes, tool);
    const port = await listenForTest(server);
    servers.push(server);
    const root = await mkdtemp(path.join(tmpdir(), 'nestos-worktree-'));
    roots.push(root);
    await initRepo(root);
    const stateDir = path.join(root, '.nestos');
    const configPath = path.join(root, 'mindos.yml');
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    await writeFile(configPath, config(port, workspaceBlock, tool), 'utf8');
    return { root, stateDir, configPath, canonical: target => realpath(target).catch(() => target) };
}

function startRun(configPath: string, stateDir: string): ChildProcess {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'run', '-f', configPath,
        '--state-dir', stateDir, '--headless', '--json'], { cwd: CLI_CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    return child;
}

async function latestRun(stateDir: string): Promise<string> {
    return (await readdir(path.join(stateDir, 'runs')))[0]!;
}

async function manifest(stateDir: string, runId: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(path.join(stateDir, 'runs', runId, 'run.json'), 'utf8'));
}

const exists = (target: string): Promise<boolean> => access(target).then(() => true, () => false);

it('runs the node inside the worktree and leaves the base repository untouched', async () => {
    // `cleanup: keep` so the worktree survives for inspection after the Run.
    const { root, stateDir, configPath, canonical } = await setup(true, '    cleanup: keep\n');
    const child = startRun(configPath, stateDir);
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const [code] = await once(child, 'close') as [number, NodeJS.Signals | null];
    const runId = await latestRun(stateDir);
    expect(code, stderr).toBe(0);
    expect(await manifest(stateDir, runId)).toMatchObject({ status: 'succeeded' });

    const worktree = path.join(stateDir, 'worktrees', runId);
    expect(stderr).toContain(worktree);
    expect(stderr).toContain('branch: flow/');
    expect(await readFile(path.join(worktree, 'marker.txt'), 'utf8')).toBe('worktree');
    // The marker must not exist in the base repository: the agent really ran in the worktree.
    expect(await exists(path.join(root, 'marker.txt'))).toBe(false);
    expect(await listedWorktrees(root)).toContain(await canonical(worktree));
    expect(await git(root, ['status', '--porcelain', '--', 'base.txt'])).toBe('');
}, 30_000);

it('points the VFS file tools at the isolated copy, not the base repository', async () => {
    const { root, stateDir, configPath } = await setup(true, '    cleanup: keep\n', 'Write');
    const child = startRun(configPath, stateDir);
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const [code] = await once(child, 'close') as [number, NodeJS.Signals | null];
    const runId = await latestRun(stateDir);
    expect(code, stderr).toBe(0);
    const worktree = path.join(stateDir, 'worktrees', runId);
    // The Write tool resolves `/workspace` through the Session mount, which is the worktree.
    expect(await readFile(path.join(worktree, 'written.txt'), 'utf8')).toBe('from vfs');
    expect(await exists(path.join(root, 'written.txt'))).toBe(false);
    // The agent uses virtual paths; only the host resolves the isolated directory.
    expect(prompts.join('\n')).toContain('/workspace');
    expect(prompts.join('\n')).not.toContain(worktree);
}, 30_000);

it('refuses a model-requested file tool outside the declared grants', async () => {
    const { root, stateDir, configPath } = await setup(true, '    cleanup: keep\n', 'Write');
    const definition = await readFile(configPath, 'utf8');
    await writeFile(configPath, definition.replace('tools: [Write]', 'tools: [Bash]'));
    const child = startRun(configPath, stateDir);
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
    child.stdout!.resume();
    const [code] = await once(child, 'close');
    expect(code, stderr).toBe(1);
    expect(stderr).toContain('Tool is not authorized for this task: Write');
    const runId = await latestRun(stateDir);
    expect(await exists(path.join(stateDir, 'worktrees', runId, 'written.txt'))).toBe(false);
    expect(await exists(path.join(root, 'written.txt'))).toBe(false);
}, 30_000);

it('removes a clean worktree after a successful Run under the default cleanup policy', async () => {
    const { root, stateDir, configPath, canonical } = await setup(false);
    const child = startRun(configPath, stateDir);
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const [code] = await once(child, 'close') as [number, NodeJS.Signals | null];
    const runId = await latestRun(stateDir);
    expect(code, stderr).toBe(0);
    const worktree = path.join(stateDir, 'worktrees', runId);
    expect(await exists(worktree)).toBe(false);
    expect(await listedWorktrees(root)).not.toContain(await canonical(worktree));
    // `merge: manual` keeps the branch for a human decision.
    expect((await git(root, ['branch', '--list', 'flow/*'])).trim()).not.toBe('');
    expect(stderr).toContain('Retained branch: flow/');
}, 30_000);

it('keeps a dirty worktree instead of deleting uncommitted agent work', async () => {
    const { root, stateDir, configPath, canonical } = await setup(true);
    const child = startRun(configPath, stateDir);
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const [code] = await once(child, 'close') as [number, NodeJS.Signals | null];
    const runId = await latestRun(stateDir);
    // Cleanup failure must not rewrite the Run result, and must not discard the file.
    expect(code, stderr).toBe(0);
    expect(await manifest(stateDir, runId)).toMatchObject({ status: 'succeeded' });
    const worktree = path.join(stateDir, 'worktrees', runId);
    expect(stderr).toContain(worktree);
    expect(stderr).toContain('branch: flow/');
    expect(await readFile(path.join(worktree, 'marker.txt'), 'utf8')).toBe('worktree');
    expect(await listedWorktrees(root)).toContain(await canonical(worktree));
}, 30_000);

it('re-attaches the recorded worktree when a crashed host resumes', async () => {
    // The first model call hangs so the process can be killed with the Run in flight.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let requested!: () => void;
    const firstRequest = new Promise<void>(resolve => { requested = resolve; });
    let calls = 0;
    const server = createServer((request, response) => {
        request.on('data', () => undefined);
        request.on('end', async () => {
            calls += 1;
            if (calls === 1) {
                requested();
                await gate;
                response.destroy();
                return;
            }
            // The replayed call asks for Bash; the round after it finishes the node.
            if (calls === 2) {
                sendJson(response, {
                    role: 'assistant', content: null,
                    tool_calls: [{
                        id: 'call_1', type: 'function',
                        function: { name: 'Bash', arguments: JSON.stringify({ command: 'printf worktree > marker.txt' }) },
                    }],
                }, 'tool_calls');
                return;
            }
            sendJson(response, { role: 'assistant', content: 'done' }, 'stop');
        });
    });
    servers.push(server);
    const port = await listenForTest(server);
    const root = await mkdtemp(path.join(tmpdir(), 'nestos-worktree-resume-'));
    roots.push(root);
    await initRepo(root);
    const stateDir = path.join(root, '.nestos');
    const configPath = path.join(root, 'mindos.yml');
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    await writeFile(configPath, config(port, '    cleanup: keep\n'), 'utf8');

    const child = startRun(configPath, stateDir);
    await firstRequest;
    child.kill('SIGKILL');
    await once(child, 'exit');
    const runId = await latestRun(stateDir);
    const worktree = path.join(stateDir, 'worktrees', runId);
    expect(await exists(worktree)).toBe(true);
    expect(await manifest(stateDir, runId)).toMatchObject({ status: 'running' });

    // Wait out the killed owner's leases, then resume: the executor must restore the
    // recorded worktree instead of preparing a second one.
    await new Promise(resolve => setTimeout(resolve, 1_800));
    release();
    expect(await resumeCommand(runId, { stateDir, headless: true, json: true })).toBe(3);
    expect(await resumeCommand(runId, { stateDir, headless: true, json: true, retryIndeterminate: true })).toBe(0);
    expect(await manifest(stateDir, runId)).toMatchObject({ status: 'succeeded' });
    expect(await readFile(path.join(worktree, 'marker.txt'), 'utf8')).toBe('worktree');
    expect(await listedWorktrees(root)).toEqual([await realpath(root), await realpath(worktree)]);
}, 40_000);
