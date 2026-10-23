import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime } from '@itookit/app-core';
import { FlowLibraryCommand } from '@itookit/app-contracts';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { FlowCommand, type FlowDraft, type FlowRevision } from '@itookit/llm-flow/contracts';
import { CliDirectorySourceProvider } from '../src/directories';
import { NodeNativeShell } from '../src/shell';

const definitionPath = fileURLToPath(new URL('../examples/raptor/raptor-review.flow', import.meta.url));
const agentPath = fileURLToPath(new URL('../examples/raptor/raptor-review.agent', import.meta.url));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const finding = { check_id: 'raptor.python.insecure-tempfile', path: 'demo.py', start: { line: 3, col: 12 }, end: { line: 3, col: 29 },
    extra: { message: 'Insecure temporary file creation', severity: 'HIGH', metadata: { cwe: ['CWE-377'] } } };

function verdict() {
    return { ruleId: finding.check_id, path: finding.path, line: 3, verdict: 'true_positive', exploitability: 'uncertain', confidence: 0.9,
        stages: { aVerification: 'tempfile.mktemp appears on line 3.', bAttackPath: 'A race is possible when the path is subsequently opened.',
            cSanity: 'The source defines the helper but provides no external caller.', dRuling: 'The insecure API is real; exploitation requires additional code.' },
        evidence: [{ file: 'demo.py', line: 3, reason: 'tempfile.mktemp() returns a name without atomically creating a file.' }], limitations: ['No external call path is proven.'] };
}

function mockModel(revise: boolean, invalidAttempts = 0, judge: Record<string, unknown> = {}) {
    const requests: Array<{ role: string; messages: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        const request = JSON.parse(options.body), text = JSON.stringify(request.messages);
        const role = ['PRIMARY', 'CONSENSUS', 'JUDGE', 'REVISE'].find(name => text.includes(`RAPTOR_${name}`)) ?? 'UNKNOWN';
        requests.push({ role, messages: request.messages });
        const result = role === 'JUDGE' ? { needsRevision: revise, agreement: revise ? 'insufficient_evidence' : 'agree', reason: 'Fixture adjudication', unresolvedQuestions: [], ...judge }
            : { ...verdict(), limitations: [`${role}_PRIVATE_MARKER`] };
        const content = role === 'PRIMARY' && invalidAttempts-- > 0 ? 'Invalid JSON fixture' : JSON.stringify(result);
        return new Response(JSON.stringify({ id: 'fixture', model: 'fixture', choices: [{ index: 0,
            message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }), { headers: { 'content-type': 'application/json' } });
    }));
    return requests;
}

async function configuredBackend(live: boolean) {
    const backend = new MemoryBackend(); await backend.init();
    for (const directory of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(directory);
    const write = (file: string, value: unknown) => backend.write(file, new TextEncoder().encode(JSON.stringify(value)));
    let provider: Record<string, unknown> = { id: 'fixture', name: 'Fixture', implementation: 'openai-compatible', apiKey: 'fixture',
        baseURL: 'http://raptor-flow.invalid', models: [{ id: 'fixture', name: 'Fixture' }] };
    let connection: Record<string, unknown> = { id: 'default', name: 'Default', providerId: 'fixture', protocol: 'openai-chat', tiers: { standard: 'fixture', fast: 'fixture', optimal: 'fixture' } };
    if (live) {
        const profile = process.env.RAPTOR_FLOW_PROFILE!;
        connection = JSON.parse(await readFile(path.join(profile, 'etc/llm/.connections/default.json'), 'utf8'));
        provider = JSON.parse(await readFile(path.join(profile, `etc/llm/.providers/${connection.providerId}.json`), 'utf8'));
        const tiers = connection.tiers as Record<string, string>;
        connection = { ...connection, tiers: { ...tiers, optimal: tiers.fast ?? tiers.standard } };
    }
    await write(`/etc/llm/.providers/${provider.id}.json`, provider);
    await write('/etc/llm/.connections/default.json', connection);
    await write('/etc/llm/.connection-settings.json', { defaultConnectionId: 'default' });
    return backend;
}

type ScanOptions = { live?: boolean; exitCode?: number; oversized?: boolean; empty?: boolean; malformed?: 'json' | 'shape' | 'errors' };
function scanOutput(options: ScanOptions) {
    if (options.oversized) return 'x'.repeat(60_000);
    if (options.malformed === 'json') return '{invalid';
    if (options.malformed === 'shape') return '{}';
    return JSON.stringify({ results: options.empty ? [] : [finding],
        errors: options.malformed === 'errors' ? [{ type: 'ParseError', message: 'Fixture partial scan failure' }] : [], paths: { scanned: ['demo.py'] } });
}

async function setup(options: ScanOptions = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'raptor-native-flow-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace'); await mkdir(workspace);
    await writeFile(path.join(workspace, 'demo.py'), 'import tempfile\ndef allocate_temp_path():\n    return tempfile.mktemp()\n');
    const backend = await configuredBackend(!!options.live), shell = new NodeNativeShell();
    const executions: string[] = [];
    const runtime = await createApplicationRuntime({ backend, ownerKind: 'cli', digitalTwinAutoStart: false,
        defaultSessionDirectory: workspace, directorySourceProvider: new CliDirectorySourceProvider(path.join(root, 'profile')),
        kernelPlatform: { createSessionProcesses: async () => ({ release: async () => {}, nativeShell: {
            capabilities: shell.capabilities, exec: async (command, args, settings) => {
                executions.push(args.join(' '));
                expect(args.join(' ')).not.toMatch(/raptor\.py|raptor_agentic|python\s+-c|node\s+-e/);
                if (options.live) return shell.exec(command, args, { ...settings, cwd: workspace });
                return { code: options.exitCode ?? 0, stderr: '', stdout: scanOutput(options) };
            },
        } }) } });
    cleanup.push(() => runtime.dispose());
    const definition = JSON.parse(await readFile(definitionPath, 'utf8')) as FlowDraft;
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [definition] });
    const agent = JSON.parse(await readFile(agentPath, 'utf8')); await runtime.agentService.saveAgent(agent);
    const id = await runtime.sessionRepository.createSession('Native RAPTOR rule review');
    await runtime.commandBus.execute(SessionCommand.Bind, { sessionId: id });
    return { runtime, id, root, workspace, definition, agent, executions };
}

async function run(f: Awaited<ReturnType<typeof setup>>, timeout = 15_000) {
    await f.runtime.commandBus.execute(SessionCommand.Send, { text: 'Review this disposable Python fixture. Do not execute target code. REQUEST_REQUIREMENT_MARKER', files: [], agentId: f.agent.id });
    await vi.waitFor(async () => {
        const [round] = (await f.runtime.sessionRepository.readHistoryChain(f.id)).rounds;
        expect(round && ['completed', 'failed', 'cancelled'].includes(round.status)).toBe(true);
    }, { timeout, interval: 100 }).catch(async () => {
        const pending = await f.runtime.kernel.kernel.listSessionTasks(f.id);
        throw new Error(JSON.stringify(pending.map(task => ({ id: task.id, node: task.labels?.flowNodeId, status: task.status,
            wait: task.wait, error: task.exit?.error?.message, lastError: task.lastError?.message }))));
    });
    const tasks = await f.runtime.kernel.kernel.listSessionTasks(f.id);
    const root = tasks.find(task => task.labels?.kind === 'flow-root')!;
    return { root, tasks, rounds: (await f.runtime.sessionRepository.readHistoryChain(f.id)).rounds };
}

it.each([false, true])('runs the shipped Agent-bound native Flow with isolated review and at most one revision (%s)', async revise => {
    const requests = mockModel(revise), f = await setup(), outcome = await run(f);
    expect(outcome.root.status, JSON.stringify(outcome.root.exit)).toBe('succeeded');
    expect(f.executions).toHaveLength(1);
    expect(requests.map(request => request.role).sort()).toEqual((revise ? ['PRIMARY', 'CONSENSUS', 'JUDGE', 'REVISE'] : ['PRIMARY', 'CONSENSUS', 'JUDGE']).sort());
    const blind = JSON.stringify(requests.find(request => request.role === 'CONSENSUS')!.messages);
    expect(blind).not.toContain('RAPTOR_PRIMARY'); expect(blind).not.toContain('PRIMARY_PRIVATE_MARKER');
    const judge = JSON.stringify(requests.find(request => request.role === 'JUDGE')!.messages);
    expect(judge).toContain('PRIMARY_PRIVATE_MARKER'); expect(judge).toContain('CONSENSUS_PRIVATE_MARKER');
    expect(JSON.stringify(requests.find(request => request.role === 'PRIMARY')!.messages)).toContain('REQUEST_REQUIREMENT_MARKER');
    const text = JSON.stringify(outcome.root.output); expect(text).toContain(finding.check_id); expect(text).toContain('true_positive');
    expect(await readFile(path.join(f.workspace, 'raptor-rules.yaml'), 'utf8')).toContain('raptor.python.insecure-tempfile');
}, 20_000);

it.each([{ exitCode: 2 }, { oversized: true }])('rejects failed or truncated scans before model review (%j)', async options => {
    const requests = mockModel(false), f = await setup(options), outcome = await run(f);
    expect(outcome.root.status).toBe('failed'); expect(requests).toHaveLength(0);
    expect(outcome.root.exit?.error?.message).toMatch(/Invalid output|exitCode|truncated|Complete JSON result/);
}, 20_000);

it.each(['json', 'shape', 'errors'] as const)('rejects malformed scanner output (%s) before model review', async malformed => {
    const requests = mockModel(false), f = await setup({ malformed }), outcome = await run(f);
    expect(outcome.root.status).toBe('failed'); expect(requests).toHaveLength(0);
});

it.each([1, Infinity])('repairs invalid model JSON within its declared budget (%s)', async attempts => {
    const requests = mockModel(false, attempts), f = await setup(), outcome = await run(f);
    expect(outcome.root.status).toBe(attempts === 1 ? 'succeeded' : 'failed');
    expect(requests.filter(request => request.role === 'PRIMARY')).toHaveLength(attempts === 1 ? 2 : 3);
    if (attempts === Infinity) expect(outcome.root.exit?.error?.message).toContain('output repair attempts exhausted (2/2)');
}, 20_000);

it.each([{ agreement: 'disagree' }, { unresolvedQuestions: ['Verify reachability'] }])('revises material judge concerns even when needsRevision is false (%j)', async judge => {
    const requests = mockModel(false, 0, judge), f = await setup(), outcome = await run(f);
    expect(outcome.root.status, JSON.stringify(outcome.root.exit)).toBe('succeeded');
    expect(requests.filter(request => request.role === 'REVISE')).toHaveLength(1);
}, 20_000);

it('returns an empty review list without model calls when the scanner has no findings', async () => {
    const requests = mockModel(false), f = await setup({ empty: true }), outcome = await run(f);
    expect(outcome.root.status, JSON.stringify(outcome.root.exit)).toBe('succeeded'); expect(requests).toHaveLength(0);
    expect(JSON.stringify(outcome.root.output)).toContain('findingCount');
}, 20_000);

function observeLiveRequests() {
    const requests: Array<Record<string, unknown>> = [];
    const send = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request: Record<string, unknown> = {}; requests.push(request);
        if (typeof init?.body === 'string') {
            const body = JSON.parse(init.body);
            request.model = body.model;
            request.messages = (body.messages ?? []).map((message: { role: string; content: unknown }) => ({ role: message.role,
                blocks: Array.isArray(message.content) ? message.content.map(block => ({ type: block.type, id: block.id ?? block.tool_use_id })) : [{ type: 'text' }] }));
        }
        const response = await send(url, init), body = await response.clone().json().catch(() => ({}));
        const text = (body.content ?? []).filter((block: { type: string }) => block.type === 'text').map((block: { text: string }) => block.text).join('');
        let validJson = false; try { JSON.parse(text); validJson = true; } catch { /* Record format metadata only. */ }
        request.response = { status: response.status, stopReason: body.stop_reason, usage: body.usage, textLength: text.length,
            validJson, fenced: text.trimStart().startsWith('```'), blockTypes: (body.content ?? []).map((block: { type: string }) => block.type) };
        return response;
    });
    return requests;
}

it.runIf(process.env.RAPTOR_FLOW_LIVE === '1')('executes real RAPTOR rules and real model reviews through the published Flow Agent', async () => {
    expect(process.env.RAPTOR_FLOW_PROFILE).toBeTruthy(); expect(process.env.RAPTOR_FLOW_SEMGREP_BIN).toBeTruthy();
    vi.stubEnv('PATH', `${path.dirname(process.env.RAPTOR_FLOW_SEMGREP_BIN!)}:${process.env.PATH}`);
    const requests = observeLiveRequests();
    const f = await setup({ live: true }), outcome = await run(f, 240_000);
    const published = await f.runtime.commandBus.execute<FlowRevision>(FlowCommand.RevisionGet, { id: f.definition.id });
    const evidence = { recordedAt: new Date().toISOString(), definitionSha256: createHash('sha256').update(await readFile(definitionPath)).digest('hex'),
        sessionId: f.id, rootTaskId: outcome.root.id, status: outcome.root.status, source: 'real-semgrep-and-model',
        published: { id: published.id, revision: published.revision, digest: published.digest },
        agentId: f.agent.id, execution: f.agent.execution, commands: f.executions, requests,
        tasks: outcome.tasks.map(task => ({ id: task.id, nodeId: task.labels?.flowNodeId, status: task.status })), output: outcome.root.output };
    const target = process.env.RAPTOR_FLOW_EVIDENCE ?? '/tmp/x1-raptor-native-flow-evidence.json';
    await writeFile(target, JSON.stringify(evidence, null, 2));
    await writeFile(`${target}.${outcome.root.id}.${outcome.root.status}.json`, JSON.stringify(evidence, null, 2));
    expect(outcome.root.status, JSON.stringify(outcome.root.exit)).toBe('succeeded'); expect(f.executions).toHaveLength(1);
    expect(outcome.tasks.filter(task => ['review/0/initial', 'review/0/consensus', 'review/0/judge'].includes(task.labels?.flowNodeId ?? ''))).toHaveLength(3);
    const output = JSON.stringify(outcome.root.output); expect(output).toContain(finding.check_id); expect(output).toContain('stages');
}, 260_000);
