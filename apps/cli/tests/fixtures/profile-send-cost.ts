import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApplicationRuntime } from '@itookit/app-core';
import { openLocalFSBackend, type ISidecarDb } from '@itookit/vfsdriver-local';
import { NodeSqliteSidecarDb } from '@itookit/node-host/storage';
import { listenForTest } from '../listen';

// Counts logical sidecar calls, not Tauri IPC: one sidecar method may issue multiple SQL calls.
let recording = false, started = 0;
const operations = new Map<string, number>(), signatures = new Map<string, number>();
const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
const sorted = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1]);

function measured(db: ISidecarDb): ISidecarDb {
    return new Proxy(db, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
            if (recording) {
                bump(operations, String(key));
                bump(signatures, `${String(key)} ${args.slice(0, 2).map(String).join(' :: ')}`);
            }
            return value.apply(target, args);
        };
    } });
}

function reply(response: ServerResponse, stream: boolean): void {
    const base = { id: 'probe', created: 1, model: 'mock-model', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    if (!stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0,
            message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] }));
        return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0,
        delta: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
}

async function seed(root: string, port: number): Promise<void> {
    for (const directory of ['.providers', '.connections']) await mkdir(path.join(root, 'etc/llm', directory), { recursive: true });
    await writeFile(path.join(root, 'etc/llm/.providers/mock.json'), JSON.stringify({ id: 'mock', name: 'Mock',
        implementation: 'openai-compatible', apiKey: 'test', baseURL: `http://127.0.0.1:${port}`,
        models: [{ id: 'mock-model', name: 'Mock' }] }));
    await writeFile(path.join(root, 'etc/llm/.connections/default.json'), JSON.stringify({ id: 'default', name: 'Default',
        providerId: 'mock', tiers: { standard: 'mock-model', optimal: 'mock-model' } }));
}

async function main(): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), 'nestos-send-cost-'));
    let result: unknown;
    let reached!: () => void;
    const received = new Promise<void>(resolve => { reached = resolve; });
    const server = createServer((request, response) => {
        let body = ''; request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            if (recording) {
                recording = false;
                result = { boundary: 'send-to-provider-request', elapsedMs: Date.now() - started,
                    sidecarCalls: [...operations.values()].reduce((sum, count) => sum + count, 0),
                    operations: Object.fromEntries(sorted(operations)), topSignatures: sorted(signatures).slice(0, 20) };
                reached();
            }
            reply(response, Boolean(JSON.parse(body).stream));
        });
    });
    try {
        await seed(root, await listenForTest(server));
        await run(root, received);
        if (!result) throw new Error('Send completed without reaching the model provider');
        console.log(JSON.stringify(result, null, 2));
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
    }
}

async function run(root: string, received: Promise<void>): Promise<void> {
    const backend = await openLocalFSBackend({ rootDir: root, sidecarDir: path.join(root, '_meta'),
        createDb: async file => measured(await NodeSqliteSidecarDb.open(file)) });
    const runtime = await createApplicationRuntime({ backend, ownerKind: 'tauri' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const sessionId = await runtime.sessionRepository.createSession('send-cost');
        await runtime.sessionManager.bindSession(sessionId);
        operations.clear(); signatures.clear(); started = Date.now(); recording = true;
        await runtime.sessionManager.sendMessage('ping', [], 'default');
        await Promise.race([received, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Provider request timed out')), 30_000);
        })]);
    } finally { clearTimeout(timer); recording = false; await runtime.dispose(); }
}

await main();
