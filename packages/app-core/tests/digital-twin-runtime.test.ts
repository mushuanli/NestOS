import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { SessionCommand } from '@itookit/llm-session';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';

afterEach(() => vi.unstubAllGlobals());
it('extracts through the durable kernel and uses approved context in a later real conversation', async () => {
    const backend = new MemoryBackend(); await backend.init();
    for (const path of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(path);
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    await backend.write('/etc/llm/.providers/mock.json', encode({ id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'test',
        baseURL: 'http://localhost:18449', models: [{ id: 'mock-model', name: 'Mock' }] }));
    await backend.write('/etc/llm/.connections/default.json', encode({ id: 'default', name: 'Default', providerId: 'mock', tiers: { standard: 'mock-model' } }));
    await backend.write('/etc/llm/.connection-settings.json', encode({ defaultConnectionId: 'default' }));
    const requests: Array<any> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        const request = JSON.parse(options.body); requests.push(request);
        const extraction = request.messages.some((message: any) => message.content?.startsWith('Extract personal-context'));
        const content = extraction ? JSON.stringify({ candidates: [{ content: 'Alpha 使用 TypeScript', kind: 'preference', subject: 'self',
            project: 'Alpha', eventTime: '', quote: '我希望 Alpha 使用 TypeScript。' }] }) : '已参考 Alpha 的技术偏好';
        if (request.stream) return new Response('data: ' + JSON.stringify({ id: 'completion', model: 'mock-model',
            choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + '\n\ndata: [DONE]\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } });
        return new Response(JSON.stringify({ id: 'completion', object: 'chat.completion', created: 1, model: 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const diagnostic: string[] = [];
    const runtime = await createApplicationRuntime({ backend, ownerKind: 'web', llmLogger: {
        logMessage: (_id, _role, content) => { diagnostic.push(content); },
        logRequest: (_id, request) => { diagnostic.push(JSON.stringify(request)); }, logResponse: () => {} } });
    try {
        const fs = await runtime.vfs.openFileSystem('/');
        await fs.driver.createFile({ parentPath: '/home/admin/minds', name: 'context.md', content: '我希望 Alpha 使用 TypeScript。', recursive: true });
        const twin = runtime.digitalTwin!;
        const source = await twin.addSource({ kind: 'file', target: '/home/admin/minds/context.md', label: 'Context' }, 'default');
        await twin.analyze(source);
        const candidate = (await twin.snapshot()).memories[0];
        expect(candidate.data.state).toBe('candidate');
        await twin.review(candidate.id, candidate.revision, 'confirm');
        const id = await runtime.sessionRepository.createSession('Consumer');
        await runtime.commandBus.execute(SessionCommand.Bind, { sessionId: id });
        await runtime.commandBus.execute(SessionCommand.Send, { text: 'Alpha 用什么语言？', files: [], agentId: 'default',
            overrides: { executionMode: 'chat', streamMode: true, webSearchEnabled: false },
            sendIntent: { branch: { mode: 'continue' }, retention: { mode: 'persistent' }, execution: { kind: 'agent', agentId: 'default', mode: 'chat' } } });
        await vi.waitFor(async () => { expect((await runtime.kernel.kernel.listSessionTasks(id))[0]?.status).toBe('succeeded'); }, { timeout: 10000 });
        expect(requests).toHaveLength(2);
        expect(requests[0].max_tokens).toBe(8192);
        expect(requests[0]).not.toHaveProperty('max_completion_tokens');
        expect(requests[0]).not.toHaveProperty('max_output_tokens');
        expect(requests[0].stream).toBe(false);
        const extractionJob = (await twin.snapshot()).jobs[0].data;
        expect(extractionJob.requestStartedAt).toBeGreaterThan(0);
        expect(extractionJob.responseCompletedAt).toBeGreaterThanOrEqual(extractionJob.requestStartedAt!);
        expect(JSON.stringify(requests[1].messages)).toContain('Alpha 使用 TypeScript');
        expect((await twin.snapshot()).uses).toHaveLength(1);
        expect(diagnostic.join('')).not.toContain('Alpha');
        expect(diagnostic.join('')).toContain('redacted');
        await expect(runtime.kernel.kernel.openSession('twin-analysis-' + (await twin.snapshot()).jobs[0].id)).rejects.toThrow('Session not found');
    } finally { await runtime.dispose(); }
});

it('persists the real provider rejection with timestamps through the Web kernel path', async () => {
    const backend = new MemoryBackend(); await backend.init();
    for (const path of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(path);
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    await backend.write('/etc/llm/.providers/mock.json', encode({ id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'test-secret',
        baseURL: 'http://localhost:18449', models: [{ id: 'mock-model', name: 'Mock' }] }));
    await backend.write('/etc/llm/.connections/default.json', encode({ id: 'default', name: 'Default', providerId: 'mock', tiers: { standard: 'mock-model' } }));
    await backend.write('/etc/llm/.connection-settings.json', encode({ defaultConnectionId: 'default' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Unsupported response_format', type: 'invalid_request_error' } }),
        { status: 400, headers: { 'content-type': 'application/json' } })));
    const runtime = await createApplicationRuntime({ backend, ownerKind: 'web', digitalTwinAutoStart: false });
    try {
        const fs = await runtime.vfs.openFileSystem('/');
        await fs.driver.createFile({ parentPath: '/home/admin/minds', name: 'test.md', content: '我喜欢茶。' });
        const source = { kind: 'file' as const, target: '/home/admin/minds/test.md', label: 'test.md' };
        const sourceId = await runtime.digitalTwin!.addSource(source, 'default');
        await expect(runtime.digitalTwin!.analyze(sourceId)).rejects.toThrow('TWIN_EXTRACTION_FAILED');
        const info = await runtime.digitalTwin!.selectionInfo(source), job = info.jobs[0];
        expect(job.data.state).toBe('failed');
        expect(job.data.errorDetail).toContain('Unsupported response_format');
        expect(job.data.errorDetail).toContain('waiting');
        expect(job.data.errorDetail).not.toContain('test-secret');
        expect(job.data.createdAt).toBeGreaterThan(0);
        expect(job.data.startedAt).toBeGreaterThanOrEqual(job.data.createdAt!);
        expect(job.data.finishedAt).toBeGreaterThanOrEqual(job.data.startedAt!);
        expect(info.runs[0].data.errorDetail).toContain('Unsupported response_format');
    } finally { await runtime.dispose(); }
});
