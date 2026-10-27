// @file: apps/cli/tests/run-skill-context.test.ts
// P0-00 (CLI half): a CLI new Run must assemble the same project rules + selected Skill
// content as the real app. This drives the real CLI runtime against a mock model and
// inspects the actual model requests, then re-runs in the same data root to show the
// persisted loaded identity is reused instead of re-matching.
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SeqFileKernelStore } from '@itookit/durable-kernel';
import { parseLoadedSkillIds } from '@itookit/kernel-adapters';
import { listenForTest } from './listen';
import { runCommand } from '../src/commands';
import { CliStorageResolver, cliStorage, openProfileInspectionFs } from '../src/runtime';

const servers: ReturnType<typeof createServer>[] = [];
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
    delete process.env.NESTOS_TEST_API_KEY;
});

function config(port: number, goal = 'Review the interface change'): string {
    return `version: 1
name: skill-context
goal: ${goal}
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
tasks:
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

/** SSE server that records every request body for assertion. */
function recordingServer(): { server: ReturnType<typeof createServer>; bodies: string[] } {
    const bodies: string[] = [];
    const server = createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            bodies.push(body);
            const chunk = (text: string, finish: string | null) => JSON.stringify({
                id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock-model',
                choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: finish }],
                usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
            });
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.write(`data: ${chunk('done', null)}\n\n`);
            response.write(`data: ${chunk('', 'stop')}\n\n`);
            response.end('data: [DONE]\n\n');
        });
    });
    return { server, bodies };
}

async function latestRun(stateDir: string): Promise<string> {
    return (await readdir(path.join(stateDir, 'runs')))[0]!;
}

/** Read the durable loaded-Skill identity a run's Session kernel recorded. */
async function loadedSkills(stateDir: string, runId: string): Promise<unknown> {
    const { fs, dispose } = await openProfileInspectionFs(stateDir);
    try {
        const resolver = new CliStorageResolver(fs);
        const binding = await resolver.resolve(cliStorage(runId));
        const store = new SeqFileKernelStore(binding, reference => resolver.resolve(reference));
        const value = (await store.getShared(binding, 'kernel-adapters.skills.loaded'))?.value;
        return value === undefined ? undefined : parseLoadedSkillIds(value);
    } finally { await dispose(); }
}

/** The run directory a command created, identified by diffing the runs folder. */
async function newRunId(stateDir: string, run: () => Promise<unknown>): Promise<string> {
    const runsDir = path.join(stateDir, 'runs');
    const before = new Set(await readdir(runsDir).catch(() => []));
    expect(await run()).toBe(0);
    const created = (await readdir(runsDir)).find(id => !before.has(id));
    if (!created) throw new Error('the command did not create a run');
    return created;
}

it('assembles project rules and auto-loaded Skills into the CLI run and persists the loaded identity', async () => {
    const model = recordingServer();
    servers.push(model.server);
    const port = await listenForTest(model.server);
    const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-skill-context-'));
    roots.push(workspace);
    // The CLI host reads project rules from `_agent/AGENT.md` and Skills from `_agent/skills/*`.
    await mkdir(path.join(workspace, '_agent', 'skills', 'review'), { recursive: true });
    await writeFile(path.join(workspace, '_agent', 'AGENT.md'), 'Always cite the interface contract.', 'utf8');
    await writeFile(path.join(workspace, '_agent', 'skills', 'review', 'SKILL.md'), [
        '---', 'name: Review', 'description: Review changes', '---',
        'Check every changed interface.',
        '', '## Compact Instructions', '- [红线] Preserve access checks.', '- Background note.',
    ].join('\n'), 'utf8');
    const configPath = path.join(workspace, 'mindos.yml');
    const stateDir = path.join(workspace, '.nestos');
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    await writeFile(configPath, config(port), 'utf8');

    expect(await runCommand({ file: configPath, stateDir, headless: true, json: true })).toBe(0);
    const first = model.bodies.join('\n');
    expect(first).toContain('Always cite the interface contract.');
    expect(first).toContain('Check every changed interface.');
    // Only `[红线]` entries become protected critical rules in this context path.
    expect(first).toContain('Preserve access checks.');
    expect(first).not.toContain('Background note.');
    // Model requests are not the whole contract: the loaded identity is durable
    // Session state that a reopening host restores.
    const runId = await latestRun(stateDir);
    expect(await readFile(path.join(stateDir, 'runs', runId, 'result.txt'), 'utf8')).toBe('done');
    expect(JSON.stringify(await loadedSkills(stateDir, runId))).toContain('review');

    model.bodies.length = 0;
    expect(await runCommand({ file: configPath, stateDir, headless: true, json: true })).toBe(0);
    const second = model.bodies.join('\n');
    // A second Run in the same data root derives the same context again.
    expect(second).toContain('Always cite the interface contract.');
    expect(second).toContain('Check every changed interface.');
    expect(second).toContain('Preserve access checks.');
}, 30_000);

/**
 * Strict P0-00 distinction at the CLI entry: `auto-load: false` keeps a reference Skill
 * loadable but out of runs that neither loaded it nor matched it. A matched run still loads it
 * and records the durable identity, so the persisted-identity path is not confused with autoLoad.
 */
it('does not auto-inject an auto-load:false reference Skill into a non-matching CLI run', async () => {
    const model = recordingServer();
    servers.push(model.server);
    const port = await listenForTest(model.server);
    const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-skill-manual-'));
    roots.push(workspace);
    await mkdir(path.join(workspace, '_agent', 'skills', 'review'), { recursive: true });
    await writeFile(path.join(workspace, '_agent', 'AGENT.md'), 'Always cite the interface contract.', 'utf8');
    await writeFile(path.join(workspace, '_agent', 'skills', 'review', 'SKILL.md'), [
        '---', 'name: Review', 'description: Review changes interface', 'auto-load: false', '---',
        'Check every changed interface.',
    ].join('\n'), 'utf8');
    const stateDir = path.join(workspace, '.nestos');
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';

    // A new run whose goal does not match must get the project rules but not the Skill body.
    const unmatchedConfig = path.join(workspace, 'unmatched.yml');
    await writeFile(unmatchedConfig, config(port, 'Deploy the pipeline'), 'utf8');
    const unmatchedRun = await newRunId(stateDir, () => runCommand({ file: unmatchedConfig, stateDir, headless: true, json: true }));
    const unmatched = model.bodies.join('\n');
    expect(unmatched).toContain('Always cite the interface contract.');
    expect(unmatched).not.toContain('Check every changed interface.');
    expect(await loadedSkills(stateDir, unmatchedRun)).toBeUndefined();

    // A matching goal still loads it and records the durable loaded identity.
    model.bodies.length = 0;
    const matchedConfig = path.join(workspace, 'matched.yml');
    await writeFile(matchedConfig, config(port, 'review changes now'), 'utf8');
    const matchedRun = await newRunId(stateDir, () => runCommand({ file: matchedConfig, stateDir, headless: true, json: true }));
    expect(model.bodies.join('\n')).toContain('Check every changed interface.');
    expect(JSON.stringify(await loadedSkills(stateDir, matchedRun))).toContain('review');
}, 30_000);
