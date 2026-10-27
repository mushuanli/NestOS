import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openProfileInspectionFs } from '../src/runtime';
import { SessionRepository, RoundLog } from '@itookit/llm-session';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runCommand, rerunCommand, respondCommand, resumeCommand } from '../src/commands';
import { RunStore } from '../src/run-store';
import { listenForTest } from './listen';

const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function profile() {
    const requests: any[] = [];
    const server = createServer((request, response) => {
        let body = ''; request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            const value = JSON.parse(body); requests.push(value);
            const called = value.messages.some((message: any) => message.role === 'tool');
            const tool = value.tools?.[0]?.function?.name ?? value.tools?.[0]?.name;
            const message = called ? { role: 'assistant', content: '{"score":9}' } : {
                role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: tool, arguments: '{"essay":"sample"}' } }],
            };
            const finish_reason = called ? 'stop' : 'tool_calls';
            response.writeHead(200, { 'content-type': value.stream ? 'text/event-stream' : 'application/json' });
            response.end(value.stream ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason }] })}\n\ndata: [DONE]\n\n`
                : JSON.stringify({ choices: [{ index: 0, message, finish_reason }], usage: { total_tokens: 2 } }));
        });
    });
    servers.push(server); const port = await listenForTest(server);
    const root = await mkdtemp(path.join(tmpdir(), 'flow-capabilities-')); roots.push(root);
    const save = async (file: string, value: unknown) => { const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(value)); };
    await save('etc/llm/.providers/fixture.json', { id: 'fixture', name: 'Fixture', implementation: 'openai-compatible', baseURL: `http://127.0.0.1:${port}`, defaultPath: '/v1/chat/completions', apiKey: 'fixture', enabled: true, models: [{ id: 'fixture' }] });
    await save('etc/llm/.connections/default.json', { id: 'default', name: 'Default', providerId: 'fixture', protocol: 'openai-chat', enabled: true, tiers: { standard: 'fixture' } });
    await save('etc/llm/.mcp/fixture.json', { id: 'fixture', name: 'Fixture', transport: 'stdio', command: process.execPath,
        args: JSON.stringify([path.resolve('tests/fixtures/mcp-server.mjs'), path.join(root, 'mcp-calls.jsonl')]) });
    return { root, requests, save };
}

async function savedRounds(root: string, sessionId: string) {
    const inspection = await openProfileInspectionFs(root);
    try {
        const sessions = new SessionRepository(inspection.fs); await sessions.init();
        const names = (await sessions.listHistory(sessionId)).filter(name => name.startsWith('round-'));
        const rounds = await Promise.all(names.map(async name => JSON.parse((await sessions.readDocument(sessionId, name))!)));
        await sessions.dispose(); return rounds;
    } finally { await inspection.dispose(); }
}

it('runs a model-free YAML MCP input and output chain once', async () => {
    const {root, requests} = await profile();
    const file = path.join(root, 'tools.yaml');
    await writeFile(file, `version: 1
name: tool-chain
goal: Collect and store material
sandbox: { mode: native }
tasks:
  - id: fetch
    mcp: { server: fixture, tool: lookup }
    args: { essay: sample }
    approval: none
  - id: save
    mcp: { server: fixture, tool: store }
    input_argument: body
    inputs:
      input: \${tasks.fetch.outputs.result}
    approval: none
result: save
`);
    expect(await runCommand({file, profile: root, stateDir: root, json: true, headless: true})).toBe(0);
    expect(requests).toEqual([]);
    const calls = (await readFile(path.join(root, 'mcp-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.map(call => call.name)).toEqual(['lookup', 'store']);
    expect(calls[1].arguments.body.structuredContent).toEqual({score: 9});
    const [run] = await new RunStore(root).list();
    expect(run.status).toBe('succeeded');
});

it.each([[false, false, false], [true, false, false], [true, true, false], [false, false, true]])('CLI Flow calls MCP: Skill=%s, built CLI=%s, profile=%s', async (useSkill, built, useProfile) => {
    if (built) await promisify(execFile)('pnpm', ['build'], { timeout: 60000, maxBuffer: 2000000 });
    const { root, requests, save } = await profile();
    await save('etc/llm/.skills/review.yaml', { id: 'review', name: 'Review', description: '', type: 'mcp', enabled: true,
        instructions: 'EXPLICIT_SKILL_INSTRUCTIONS', compact: { marker: 'COMPACT', redLines: ['KEEP_SKILL_RULE'], rawContent: 'KEEP_SKILL_RULE' }, tools: [{ toolId: 'lookup', executionType: 'mcp',
            mcpServerId: 'fixture', mcpToolName: 'lookup', definition: { name: 'lookup', description: 'Read rubric', parameters: { type: 'object', properties: { essay: { type: 'string' } } } } }],
        triggerPatterns: [], autoLoad: false, priority: 50 });
    const target = { id: 'check', name: 'Check', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, capabilities: [],
        config: { connectionId: 'default', systemPrompt: ['CHECK_ONLY'], maxExchanges: 3, approval: useSkill ? 'external' : 'none',
            ...(useSkill ? { skillIds: ['review'] } : useProfile ? { mcpProfileIds: ['fixture'] } : { toolIds: ['mcp__fixture__lookup'] }) } };
    await save('review.flow', { id: 'review', name: 'Review', draftVersion: 1, updatedAt: 1, parameters: [], edges: [],
        nodes: [{ id: 'review', name: 'Review', plugin: 'builtin.route', pluginVersion: '2.0.0', inputs: {},
            config: { mode: 'exclusive', maxRounds: 1, until: { kind: 'literal', value: false }, context: { history: 'none' }, requireNoHistory: true,
                branches: [{ key: 'check', input: {}, prompt: 'Review sample', target, outputFormat: 'json' }] } }] });
    const options = { file: path.join(root, 'review.flow'), profile: root, stateDir: root, json: true };
    const cli = async (...args: string[]) => {
        try {
            await promisify(execFile)(process.execPath, [path.resolve('dist/cli.js'), ...args,
                '--profile', root, '--state-dir', root, '--json', '--headless'], { timeout: 20000, maxBuffer: 4000000 });
            return 0;
        } catch (error) {
            if (typeof (error as { code?: unknown }).code === 'number') return (error as { code: number }).code;
            throw error;
        }
    };
    const finish = async (code: number) => {
        expect(code).toBe(useSkill ? 3 : 0);
        const [run] = await new RunStore(options.stateDir).list();
        if (useSkill) {
            expect(run.pendingInteractions).toHaveLength(1);
            const rounds = await savedRounds(root, run.sessionId);
            expect(rounds).toHaveLength(1);
            expect(rounds[0].status).toBe('waiting');
            expect(rounds[0].result.flowInteractions.some((item: any) => item.actor?.kind === 'approval' && item.status === 'waiting_input')).toBe(true);
            expect(built ? await cli('respond', run.id, run.pendingInteractions[0].interactionId, '--approve')
                : await respondCommand(run.id, run.pendingInteractions[0].interactionId, { ...options, approve: true })).toBe(0);
            expect(built ? await cli('resume', run.id) : await resumeCommand(run.id, options)).toBe(0);
        }
        return run.id;
    };
    const id = await finish(built ? await cli('run', '-f', options.file) : await runCommand(options));
    await finish(built ? await cli('rerun', id) : await rerunCommand(id, options));
    const saved = await new RunStore(root).load(id);
    expect(saved.status).toBe('succeeded');
    const result = JSON.parse(await readFile(path.join(root, 'runs', id, saved.resultPath!), 'utf8'));
    expect(result.results.check.value.score).toBe(9);
    const events = (await readFile(path.join(root, 'runs', id, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events.some(event => event.type === 'agent.event' && event.payload.type === 'tool:success')).toBe(true);
    const inspection = await openProfileInspectionFs(root);
    try {
        const sessions = new SessionRepository(inspection.fs); await sessions.init();
        expect((await sessions.getManifest(saved.sessionId)).id).toBe(saved.sessionId);
        const log = new RoundLog(sessions, saved.sessionId);
        const round = await log.readRound(`flow-${saved.rootTaskId}`);
        expect(round?.status).toBe('completed');
        expect(JSON.stringify(round?.output)).toContain('9');
        const interactions = round?.result?.flowInteractions ?? [];
        const tool = interactions.find(item => item.actor?.kind === 'tool');
        expect(tool).toMatchObject({ status: 'success', role: 'assistant', actor: { nodeName: 'Check' } });
        expect(tool?.content).toContain('RUBRIC_FROM_MCP');
        expect(interactions.some(item => item.actor?.kind === 'node' && item.actor.nodeName === 'Check')).toBe(true);
        if (useSkill) {
            expect(tool?.actor?.skillIds).toContain('review');
            expect(interactions.some(item => item.role === 'user' && item.actor?.kind === 'approval')).toBe(true);
        }
        const records = await inspection.fs.meta.seq!.walkEntries(`/var/lib/sessions/${saved.sessionId}/kernel/events.seq`, () => true);
        expect(records.processed).toBeGreaterThan(0);
        await sessions.dispose();
    } finally { await inspection.dispose(); }
    if (built) {
        const out = path.join(root, 'export.json');
        expect(await cli('export', id, '--out', out)).toBe(0);
        const transcript = JSON.parse(await readFile(out, 'utf8'));
        expect(JSON.stringify(transcript)).toContain('RUBRIC_FROM_MCP');
        const before = await savedRounds(root, saved.sessionId);
        expect(await cli('export', id, '--out', out)).toBe(0);
        expect(await savedRounds(root, saved.sessionId)).toEqual(before);
        expect(before).toHaveLength(1);
    }
    expect((await readFile(path.join(root, 'mcp-calls.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
    expect(requests).toHaveLength(4);
    expect(requests[0].messages.every((message: any) => ['system', 'user'].includes(message.role))).toBe(true);
    expect(JSON.stringify(requests[1].messages)).toContain('RUBRIC_FROM_MCP');
    if (useSkill) { expect(JSON.stringify(requests[0].messages)).toContain('EXPLICIT_SKILL_INSTRUCTIONS'); expect(JSON.stringify(requests[0].messages)).toContain('KEEP_SKILL_RULE'); }
}, 60000);
