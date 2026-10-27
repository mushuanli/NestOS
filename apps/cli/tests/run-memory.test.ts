import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { expect, it } from 'vitest';
import { SeqFileKernelStore } from '@itookit/durable-kernel';
import { runCommand } from '../src/commands';
import { loadWorkflow } from '../src/config';
import { compileRunDefinition } from '../src/run-definition';
import { CliStorageResolver, cliStorage, openProfileInspectionFs } from '../src/runtime';
import { listenForTest } from './listen';
import { SharedMemoryStore, SessionMemoryProvider } from '@itookit/llm-session';
import { sharedMemoryCommand } from '../src/shared-memory-command';

it.each([false, true])('runs a configured CLI memory tool through HTTP model calls and persists the result (shared: %s)', async shared => {
    const root = await mkdtemp(path.join(tmpdir(), 'cli-memory-'));
    const requests: any[] = [];
    const server = createServer((request, response) => {
        let body = ''; request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            requests.push(JSON.parse(body));
            const first = requests.length === 1;
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ id: 'mock', object: 'chat.completion', created: 1, model: 'model',
                choices: [{ index: 0, message: first ? { role: 'assistant', content: '', tool_calls: [{ id: 'write', type: 'function',
                    function: { name: 'memory_write', arguments: JSON.stringify({ scope: 'project', entryId: 'note', content: 'CLI memory' }) } }] }
                    : { role: 'assistant', content: 'done' }, finish_reason: first ? 'tool_calls' : 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        });
    });
    const previous = process.env.NESTOS_MEMORY_TEST_KEY; process.env.NESTOS_MEMORY_TEST_KEY = 'test';
    try {
        const port = await listenForTest(server), file = path.join(root, 'workflow.yml'), stateDir = path.join(root, '.nestos');
        let sharedRef: { id: string; incarnation: string } | undefined;
        if (shared) {
            expect(await sharedMemoryCommand(['create', 'team', 'agent', 'creator'], { profile: stateDir })).toBe(0);
            const inspection = await openProfileInspectionFs(stateDir);
            try { const [resource] = await new SharedMemoryStore(inspection.fs).list(); sharedRef = { id: resource.id, incarnation: resource.incarnation }; }
            finally { await inspection.dispose(); }
        }
        await writeFile(file, stringify({ version: 1, name: 'memory', goal: 'remember', workspace: { root: '.' },
            providers: [{ id: 'mock', implementation: 'openai-compatible', base_url: `http://127.0.0.1:${port}`,
                default_path: '/v1/chat/completions', api_key_env: 'NESTOS_MEMORY_TEST_KEY', models: [{ id: 'model' }] }],
            connections: [{ id: 'default', provider: 'mock', tiers: { standard: 'model' } }],
            agents: [{ id: 'worker', connection: 'default', tools: ['memory_write'], stream: false, approval: 'none',
                memory_policy: { namespace_id: 'agent', read_scopes: ['project'], write_scopes: ['project'],
                    ...(sharedRef ? { shared_memory: sharedRef } : {}) } }],
            tasks: [{ id: 'finish', agent: 'worker', description: 'remember', outputs: { result: 'text' } }],
            result: { task: 'finish', output: 'result' }, sandbox: { mode: 'native' } }));
        const { workflow } = await loadWorkflow(file);
        expect(compileRunDefinition(workflow, 'digest').environment?.agents?.[0].memoryPolicy?.writeScopes).toEqual(['project']);
        expect(await runCommand({ file, stateDir, headless: true, json: true, ...(shared ? { grantMemory: ['team'] } : {}) })).toBe(0);
        expect(requests).toHaveLength(2); expect(JSON.stringify(requests[1].messages)).toContain('success');
        const { readdir } = await import('node:fs/promises');
        const [id] = await readdir(path.join(stateDir, 'runs'));
        const inspection = await openProfileInspectionFs(stateDir);
        try {
            const resolver = new CliStorageResolver(inspection.fs), binding = await resolver.resolve(cliStorage(id));
            const store = new SeqFileKernelStore(binding, reference => resolver.resolve(reference));
            const memories = sharedRef ? await new SessionMemoryProvider({} as never, new SharedMemoryStore(inspection.fs)).list(id,
                { namespaceId: 'agent', readScopes: ['project'], writeScopes: ['project'], sharedMemory: sharedRef })
                : (await store.getShared(binding, 'memory.entries.["agent","project"]'))?.value;
            expect(memories).toEqual([
                expect.objectContaining({ entryId: 'note', content: 'CLI memory' }),
            ]);
        } finally { await inspection.dispose(); }
    } finally {
        if (previous === undefined) delete process.env.NESTOS_MEMORY_TEST_KEY; else process.env.NESTOS_MEMORY_TEST_KEY = previous;
        await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
    }
});
