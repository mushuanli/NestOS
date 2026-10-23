import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { SessionCommand, type RegenerateResult, type SessionGroup, type SessionEventEnvelope } from '@itookit/llm-session';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';

afterEach(() => vi.unstubAllGlobals());

async function backend() {
    const backend = new MemoryBackend(); await backend.init();
    for (const path of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections', '/home', '/home/admin', '/home/admin/project']) await backend.mkdir(path);
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    await backend.write('/etc/llm/.providers/mock.json', encode({ id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'test',
        baseURL: 'http://localhost:18449', models: [{ id: 'mock-model', name: 'Mock' }] }));
    await backend.write('/etc/llm/.connections/default.json', encode({ id: 'default', name: 'Default', providerId: 'mock', tiers: { standard: 'mock-model' } }));
    await backend.write('/etc/llm/.connection-settings.json', encode({ defaultConnectionId: 'default' }));
    return backend;
}

it.each([
    { mode: 'agent', shell: false },
    { mode: 'agent', shell: true },
    { mode: 'chat', shell: true },
] as const)('passes default tools in $mode mode (shell=$shell) and executes a real workspace search', async ({ mode, shell }) => {
    const requests: Array<any> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        requests.push(JSON.parse(options.body));
        const call = mode === 'agent' && requests.length % 2 === 1;
        const message = call ? { role: 'assistant', content: '', tool_calls: [
            { id: 'grep-mdx', type: 'function', function: { name: 'Grep', arguments: JSON.stringify({ pattern: 'mdx', path: '.' }) } },
        ] } : { role: 'assistant', content: '/workspace/found.txt contains mdx' };
        return new Response(JSON.stringify({ id: 'completion', object: 'chat.completion', created: 1, model: 'mock-model',
            choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    let releaseSearch!: () => void;
    const searchGate = new Promise<void>(resolve => { releaseSearch = resolve; });
    const events: SessionEventEnvelope[] = [];
    const runtime = await createApplicationRuntime({ backend: await backend(), ownerKind: 'tauri', digitalTwinAutoStart: false, defaultSessionDirectory: '/home/admin/project',
        kernelPlatform: { configureSession: (_id, { toolDriver }) => {
            const invoke = toolDriver.invoke.bind(toolDriver);
            vi.spyOn(toolDriver, 'invoke').mockImplementation(async request => {
                if (request.toolId === 'Grep') await searchGate;
                return invoke(request);
            });
        }, ...(shell ? { createSessionProcesses: async () => ({
            nativeShell: { capabilities: { ripgrep: true, fd: true }, exec }, release: async () => {},
        }) } : {}) } });
    let unsubscribe = () => {};
    try {
        const source = await runtime.vfs.openFileSystem('/home/admin');
        await source.driver.createFile({ parentPath: '/project', name: 'found.txt', content: 'unique mdx evidence', recursive: true });
        await source.driver.createFile({ parentPath: '/outside', name: 'hidden.txt', content: 'hidden mdx evidence', recursive: true });
        const id = await runtime.sessionRepository.createSession('Harness tools');
        await runtime.commandBus.execute(SessionCommand.Bind, { sessionId: id });
        unsubscribe = runtime.sessionManager.onEvent(event => events.push(event));
        await runtime.commandBus.execute(SessionCommand.Send, { text: 'current dir which file include mdx string?', files: [], agentId: 'default',
            overrides: { executionMode: mode, streamMode: false, webSearchEnabled: false },
            sendIntent: { branch: { mode: 'continue' }, retention: { mode: 'persistent' }, execution: { kind: 'agent', agentId: 'default', mode } } });
        if (mode === 'agent') {
            await vi.waitFor(() => expect(events.some(event => event.type === 'tool:running')).toBe(true));
            const appended = events.findIndex(event => event.type === 'node:appended' && event.payload.node.executorType === 'tool');
            const running = events.findIndex(event => event.type === 'tool:running');
            expect(appended).toBeGreaterThanOrEqual(0);
            expect(appended).toBeLessThan(running);
            expect(events.some(event => event.type === 'tool:success')).toBe(false);
            expect(requests).toHaveLength(1);
        }
        releaseSearch();
        await vi.waitFor(async () => {
            const [task] = await runtime.kernel.kernel.listSessionTasks(id);
            expect(task?.status).toBe('succeeded');
        }, { timeout: 10_000 });
        const [task] = await runtime.kernel.kernel.listSessionTasks(id);
        const input = task.input as { tools: Array<{ function?: { name: string }; name?: string }>; allowedToolIds: string[] };
        if (mode === 'agent') {
            const progress = events.find(event => event.type === 'tool:progress'
                && event.payload.call.progress?.message?.includes('cwd: /workspace'));
            expect(progress).toMatchObject({ payload: { call: { toolId: 'grep-mdx', name: 'Grep',
                input: { pattern: 'mdx', path: '.' }, progress: { message: expect.stringContaining('cwd: /workspace') } } } });
            expect(input.allowedToolIds).toEqual(['Read', 'Glob', 'Grep', 'Write', 'Edit', ...(shell ? ['Bash'] : [])]);
            expect(input.tools.map(tool => tool.function?.name ?? tool.name)).toEqual(expect.arrayContaining(input.allowedToolIds));
            expect(requests).toHaveLength(2);
            for (const tool of requests[0].tools) expect(tool).toMatchObject({ type: 'function', function: {
                name: expect.any(String), description: expect.any(String), parameters: { type: 'object' },
            } });
            expect(requests[0].tools.find((tool: any) => tool.function.name === 'Grep').function.parameters.required).toContain('pattern');
            const result = requests[1].messages.find((message: any) => message.role === 'tool');
            expect(requests[1].messages.find((message: any) => message.role === 'assistant')).toMatchObject({
                tool_calls: [{ id: 'grep-mdx', type: 'function', function: { name: 'Grep' } }],
            });
            expect(result.content).toContain('/workspace/found.txt');
            expect(result.content).toContain('unique mdx evidence');
            expect(result.content).not.toContain('hidden mdx evidence');
            expect(task.output).toMatchObject({ exchanges: 2 });
        } else {
            expect(input.tools).toEqual([]); expect(requests).toHaveLength(1);
            expect(requests[0].tools ?? []).toEqual([]);
        }
        expect(exec).not.toHaveBeenCalled();
        await vi.waitFor(async () => expect(await runtime.commandBus.execute(SessionCommand.IsGenerating)).toBe(false));
        const sessions = await runtime.commandBus.execute<SessionGroup[]>(SessionCommand.GetSessions);
        const user = sessions.find(message => message.role === 'user')!;
        await source.driver.writeContent('/project/found.txt', 'updated mdx evidence');
        const fromAssistant = mode === 'agent' && !shell;
        const target = fromAssistant ? { assistantId: sessions.find(message => message.role === 'assistant')!.id } : { userMessageId: user.id };
        expect(await runtime.commandBus.execute(SessionCommand.CanRegenerate, {
            messageId: fromAssistant ? target.assistantId : target.userMessageId,
        })).toEqual({ allowed: true });
        const rerun = await runtime.commandBus.execute<RegenerateResult>(fromAssistant ? SessionCommand.Regenerate : SessionCommand.RegenerateFromUser, {
            ...target, options: { overrides: { executionMode: mode, streamMode: false, webSearchEnabled: false } },
        });
        expect(rerun.branchCreated).toBe(true);
        await vi.waitFor(async () => {
            const tasks = await runtime.kernel.kernel.listSessionTasks(id);
            expect(tasks).toHaveLength(2);
            expect(tasks.every(record => record.status === 'succeeded')).toBe(true);
        }, { timeout: 10_000 });
        const tasks = await runtime.kernel.kernel.listSessionTasks(id);
        const retry = tasks.find(record => record.id !== task.id)!;
        expect(retry.program).toEqual(task.program);
        expect(retry.input).toMatchObject({ allowedToolIds: input.allowedToolIds });
        expect(tasks.find(record => record.id === task.id)).toEqual(task);
        expect(requests).toHaveLength(mode === 'agent' ? 4 : 2);
        if (mode === 'agent') {
            expect(requests[2].messages.some((message: any) => message.role === 'assistant')).toBe(false);
            const repeatedSearch = requests[3].messages.find((message: any) => message.role === 'tool');
            expect(repeatedSearch.content).toContain('updated mdx evidence');
            expect(repeatedSearch.content).not.toContain('unique mdx evidence');
        }
    } finally { releaseSearch(); unsubscribe(); await runtime.dispose(); }
});
