import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import type { HarnessClient } from '@itookit/mindos-node-driver';
import type { HarnessConnectionSnapshot } from '@itookit/kernel-adapters/contracts';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { FlowLibraryCommand, InputAssetCommand } from '@itookit/app-contracts';
import {createTaskAssetStore} from '../src/runtime/task-asset-store';
import {buildTool, TaskListTool} from '@itookit/tools';
import type { FlowDraft } from '@itookit/llm-flow/contracts';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import {sha256Hex} from '@itookit/llm-context/digest';

const connection: HarnessConnectionSnapshot = { id: 'remote', name: 'Remote', kind: 'harness', nodeConnectionId: 'node',
    projectId: 'project', profileId: 'claude', version: 1, revision: 1, project: { serverProjectId: 'native-project' } };
type Runtime = Awaited<ReturnType<typeof createApplicationRuntime>>;
const runtimes: Runtime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup(attachmentKinds?: Array<'text' | 'image'>, turnGate?: () => Promise<void>,
    additionalTools?: NonNullable<NonNullable<Parameters<typeof createApplicationRuntime>[0]>['kernelPlatform']>['additionalTools']) {
    const fetch = vi.fn(async () => { throw new Error('A remote Agent must not use a local model'); }); vi.stubGlobal('fetch', fetch);
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false, kernelPlatform: {additionalTools} });
    runtimes.push(runtime);
    const prompts: string[] = [], sessions: string[] = [], attachments: unknown[][] = [];
    vi.spyOn(runtime.executionConnections, 'freeze').mockResolvedValue(connection);
    vi.spyOn(runtime.executionConnections, 'validate').mockResolvedValue();
    vi.spyOn(runtime.executionConnections, 'acquire').mockImplementation(async () => {
        let id = '', turn = '';
        const client = { create: async () => { id = `native-${sessions.length}`; sessions.push(id); return { session: { id } }; },
            turn: async (_profile: string, _session: string, prompt: string, options?: {attachments?: unknown[]}) => { attachments.push(structuredClone(options?.attachments ?? [])); prompts.push(prompt); await turnGate?.(); turn = `${id}-turn`; return { turnId: turn }; },
            read: async () => ({ session: { id }, turns: [{ id: turn, status: 'completed', items: [
                { id: `${turn}-text`, type: 'agentMessage', text: `RESULT:${id}` },
            ] }] }),
            subscribe: () => () => {}, close: async () => {},
            eventSnapshot: async () => ({ epoch: 'events', cursor: 2, gap: false, requests: [], events: [
                { seq: 1, message: { method: 'item/completed', params: { threadId: id, turnId: turn,
                    item: { id: `${turn}-text`, type: 'agentMessage', text: `RESULT:${id}` } } } },
                { seq: 2, message: { method: 'turn/completed', params: { threadId: id, turn: { id: turn, status: 'completed' } } } },
            ] }),
        } as unknown as HarnessClient;
        return { client, epoch: 'service', workspaceId: 'native-project', release: async () => {},
            profile: { id: 'claude', kind: 'claude', projectRuntime: true, workspaces: [{ id: 'native-project' }],
                capabilities: { create: true, history: true, interrupt: true, resume: true, interactions: true, ...(attachmentKinds ? {attachments: attachmentKinds} : {}) } } };
    });
    await runtime.agentService.saveAgent({ id: 'remote-agent', name: 'Remote Agent', type: 'agent', config: { systemPrompt: 'REVIEW_INSTRUCTIONS' },
        execution: { kind: 'harness', connectionId: 'remote' } });
    return { runtime, prompts, sessions, fetch, attachments };
}
async function send(runtime: Runtime, agentId: string, text: string, files: import('@itookit/llm-session/contracts').ChatAttachment[] = []) {
    const id = await runtime.sessionRepository.createSession('Remote execution');
    await runtime.commandBus.execute(SessionCommand.Bind, { sessionId: id });
    await runtime.commandBus.execute(SessionCommand.Send, { text, files, agentId,
        sendIntent: { branch: { mode: 'continue' }, retention: { mode: 'persistent' }, execution: { kind: 'agent', agentId, mode: 'agent' } } });
    await vi.waitFor(async () => {
        const rounds = (await runtime.sessionRepository.readHistoryChain(id)).rounds;
        expect(rounds).toHaveLength(1); expect(rounds[0].status).toBe('completed');
    }, { timeout: 10_000 });
    return { id, tasks: await runtime.kernel.kernel.listSessionTasks(id), rounds: (await runtime.sessionRepository.readHistoryChain(id)).rounds };
}

it('executes an ordinary harness Agent through the real Program and broker without any local model', async () => {
    const f = await setup(), result = await send(f.runtime, 'remote-agent', 'Preserve ${param.literal}');
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain('Preserve ${param.literal}'); expect(f.prompts[0]).toContain('REVIEW_INSTRUCTIONS');
    expect(result.tasks.filter(task => task.program.kind === 'kernel-adapters.harness')).toHaveLength(1);
    expect(result.tasks.some(task => task.program.kind.startsWith('llm.'))).toBe(false);
    expect(JSON.stringify(result.rounds)).toContain('RESULT:native-0');
});

it('runs parallel Flow Agent nodes as independent native sessions and joins their actual results', async () => {
    const f = await setup();
    const flow: FlowDraft = { id: 'remote-workers', name: 'Remote workers', draftVersion: 1, updatedAt: 0,
        nodes: ['one', 'two'].map(id => ({ id, name: id, plugin: 'builtin.agent', pluginVersion: '1.0.0',
            config: { agentId: 'remote-agent', historyPolicy: 'none', instruction: `${id}: \${input.prompt}` }, inputs: {} })),
        edges: [], outputs: { first: { value: '${nodes.one.outputs.result}' }, second: { value: '${nodes.two.outputs.result}' } } } as FlowDraft;
    await f.runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [flow] });
    await f.runtime.agentService.saveAgent({ id: 'flow-agent', name: 'Remote workers', type: 'workflow', config: {}, execution: { kind: 'flow', flowId: flow.id } });
    const result = await send(f.runtime, 'flow-agent', 'Check the project');
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.sessions).toHaveLength(2); expect(new Set(f.sessions).size).toBe(2);
    expect(f.prompts).toHaveLength(2); expect(f.prompts.some(text => text.includes('one: Check the project'))).toBe(true);
    expect(f.prompts.some(text => text.includes('two: Check the project'))).toBe(true);
    expect(result.tasks.filter(task => task.program.kind === 'kernel-adapters.harness' && task.status === 'succeeded')).toHaveLength(2);
    expect(JSON.stringify(result.rounds)).toContain('RESULT:native-0'); expect(JSON.stringify(result.rounds)).toContain('RESULT:native-1');
});

async function publishAssetFlow(runtime: Runtime, id: string, images: boolean) {
    const flow: FlowDraft = {id, name: 'Asset worker', draftVersion: 1, updatedAt: 0,
        parameters: [{name: 'files', type: 'json', required: true, ...(images ? {widget: 'images', inputSource: 'composer.attachments'} : {})}],
        nodes: [{id: 'worker', name: 'Worker', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, config: {
            agentId: 'remote-agent', historyPolicy: 'none', messageTemplates: [{role: 'user', content: '${param.files}'}],
        }}], edges: [], outputs: {result: {value: '${nodes.worker.outputs.result}'}}} as FlowDraft;
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
}

it('delivers a generic uploaded text argument to the actual consuming native worker', async () => {
    const f = await setup(['text']), data = new TextEncoder().encode('\ufeffUploaded selection').buffer;
    const asset = await f.runtime.commandBus.execute(InputAssetCommand.ImportFile, {uploadId: '12345678-1234-4123-8123-123456789abc',
        name: 'notes.txt', mimeType: 'text/plain', bytes: data.byteLength, sha256: await sha256Hex(data), data});
    await publishAssetFlow(f.runtime, 'generic-file-flow', false);
    const sessionId = await f.runtime.sessionRepository.createSession('Generic native files'); await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await f.runtime.commandBus.execute(SessionCommand.Submit, {target: {kind: 'flow', id: 'generic-file-flow', version: '1'},
        source: {kind: 'arguments', value: {files: [{type: 'file', name: 'notes.txt', source: {type: 'asset', asset}}]}}});
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(sessionId)).rounds[0]?.status).toBe('completed'));
    expect(f.attachments).toEqual([[{kind: 'text', name: 'notes.txt', mimeType: 'text/plain', content: '\ufeffUploaded selection'}]]);
    expect(f.prompts).toHaveLength(1); expect(f.fetch).not.toHaveBeenCalled();
});

it('resolves a Flow composer image reference through the real Task asset reader at native dispatch', async () => {
    const f = await setup(['image']), url = 'data:image/png;base64,iVBORw0KGgo=';
    const asset = await f.runtime.commandBus.execute(InputAssetCommand.Import, {url});
    const part = {type: 'image', name: 'page.png', source: {type: 'asset', asset}};
    await publishAssetFlow(f.runtime, 'native-image-flow', true);
    const sessionId = await f.runtime.sessionRepository.createSession('Native file Flow');
    await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await f.runtime.commandBus.execute(SessionCommand.Submit, {target: {kind: 'flow', id: 'native-image-flow', version: '1'},
        source: {kind: 'composer', text: '', attachments: [part], values: {}}});
    await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(sessionId)).rounds[0]?.status).toBe('completed'), {timeout: 10000});
    const task = (await f.runtime.kernel.kernel.listSessionTasks(sessionId)).find(task => task.program.kind === 'kernel-adapters.harness')!;
    expect(task.status).toBe('succeeded'); expect(JSON.stringify(task.input)).toContain((asset as {id: string}).id);
    expect(JSON.stringify(task.input)).not.toContain('iVBORw0KGgo=');
    expect(f.attachments).toMatchObject([[{kind: 'image', name: 'page.png', mimeType: 'image/png', content: url}]]);
    expect(f.sessions).toHaveLength(1); expect(f.fetch).not.toHaveBeenCalled();
});

it('passes a file produced by a deterministic Tool to a native worker inside the same Flow', async () => {
    const tool = buildTool({name: 'FixtureAsset', version: '1.0.0', inputSchema: TaskListTool.inputSchema,
        description: async () => 'Fixture file producer', prompt: async () => '',
        call: async (_args, context) => ({data: [{type: 'file', name: 'notes.txt', source: {
            type: 'asset', asset: await context.writeAsset!(new TextEncoder().encode('\ufeffSelected tool file'), 'text/plain'),
        }}]}),
    });
    const f = await setup(['text'], undefined, [tool]);
    const flow: FlowDraft = {id: 'native-tool-file', name: 'Tool and native worker', draftVersion: 1, updatedAt: 0,
        nodes: [{id: 'source', name: 'Source', plugin: 'builtin.tool', pluginVersion: '1.0.0', capabilities: ['FixtureAsset'],
            config: {toolId: 'FixtureAsset', toolVersion: '1.0.0', args: {}, approval: 'none'}, inputs: {}},
        {id: 'worker', name: 'Worker', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, config: {
            agentId: 'remote-agent', historyPolicy: 'none', includeDependencyOutputs: false,
            messageTemplates: [{role: 'user', content: '${nodes.source.outputs.result}'}],
        }}], edges: [], outputs: {result: {value: '${nodes.worker.outputs.result}'}}} as FlowDraft;
    await f.runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    const sessionId = await f.runtime.sessionRepository.createSession('Tool asset Flow');
    await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await f.runtime.commandBus.execute(SessionCommand.Submit, {target: {kind: 'flow', id: flow.id, version: '1'}, source: {kind: 'arguments', value: {}}});
    try {
        await vi.waitFor(async () => expect((await f.runtime.sessionRepository.readHistoryChain(sessionId)).rounds[0]?.status).toBe('completed'), {timeout: 8000});
    } catch {
        const tasks = await f.runtime.kernel.kernel.listSessionTasks(sessionId);
        throw new Error(JSON.stringify(tasks.map(task => ({program: task.program.kind, status: task.status, error: task.exit?.error,
            interactionCount: Object.keys(task.interactions).length}))));
    }
    expect(f.attachments).toEqual([[{kind: 'text', name: 'notes.txt', mimeType: 'text/plain', content: '\ufeffSelected tool file'}]]);
    const tasks = await f.runtime.kernel.kernel.listSessionTasks(sessionId), consumer = tasks.find(task => task.program.kind === 'kernel-adapters.harness')!;
    expect(consumer.status).toBe('succeeded'); expect(JSON.stringify(consumer.input)).not.toContain('Selected tool file');
    expect(tasks.find(task => task.program.kind === 'kernel-adapters.tool')?.status).toBe('succeeded');
    expect(f.sessions).toHaveLength(1); expect(f.fetch).not.toHaveBeenCalled();
}, 20000);

it('refuses a Task file from an unrelated invocation before creating another native session', async () => {
    const f = await setup(['text']), first = await send(f.runtime, 'remote-agent', 'Produce a source');
    const sourceTask = first.tasks.find(task => task.program.kind === 'kernel-adapters.harness')!;
    const asset = await createTaskAssetStore(() => f.runtime.kernel.kernel).write(new TextEncoder().encode('Private source'), 'text/plain', {
        sessionId: first.id, taskId: sourceTask.id, effectId: 'source-file', operationId: 'source-file',
    });
    await publishAssetFlow(f.runtime, 'foreign-asset-flow', false);
    await expect(f.runtime.commandBus.execute(SessionCommand.Submit, {target: {kind: 'flow', id: 'foreign-asset-flow', version: '1'},
        source: {kind: 'arguments', value: {files: [{type: 'file', name: 'notes.txt', source: {type: 'asset', asset}}]}}}))
        .rejects.toMatchObject({code: 'ASSET_INPUT_TRANSFER_REQUIRED'});
    expect((await f.runtime.sessionRepository.readHistoryChain(first.id)).rounds).toHaveLength(1);
    expect((await f.runtime.kernel.kernel.listSessionTasks(first.id)).length).toBe(first.tasks.length);
    expect(f.sessions).toHaveLength(1); expect(f.prompts).toHaveLength(1); expect(f.fetch).not.toHaveBeenCalled();
});

it('sends verified text and images as native attachments while keeping history references separate', async () => {
    const f = await setup(['text', 'image']);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yAAAAABJRU5ErkJggg==', 'base64');
    const first = await send(f.runtime, 'remote-agent', 'Review these files', [
        {name: 'notes.txt', type: 'text/plain', fileRef: new Blob(['UNIQUE_NATIVE_TEXT'])},
        {name: 'pixel.png', type: 'image/png', fileRef: new Blob([png])},
    ]);
    expect(f.attachments[0]).toMatchObject([{kind: 'text', content: 'UNIQUE_NATIVE_TEXT'},
        {kind: 'image', mimeType: 'image/png', content: 'data:image/png;base64,' + png.toString('base64')}]);
    expect(f.prompts[0]).not.toContain('UNIQUE_NATIVE_TEXT');
    expect(JSON.stringify(first.rounds[0].input)).not.toContain('UNIQUE_NATIVE_TEXT');
    const input = first.tasks.find(task => task.program.kind === 'kernel-adapters.harness')!.input as any;
    expect(input.messages.at(-1).attachments).toMatchObject([{type: 'text', source: 'UNIQUE_NATIVE_TEXT'}, {type: 'image'}]);
    expect(f.fetch).not.toHaveBeenCalled();
});

it('durably dispatches an image at the declared native byte limit without a local model call', async () => {
    const f = await setup(['image']), image = new Uint8Array(256 * 1024);
    image.set(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yAAAAABJRU5ErkJggg==', 'base64'));
    await send(f.runtime, 'remote-agent', '', [{name: 'limit.png', type: 'image/png', fileRef: new Blob([image])}]);
    expect(f.attachments[0]).toHaveLength(1);
    const content = (f.attachments[0][0] as {content: string}).content.split(',')[1];
    expect(Buffer.from(content, 'base64')).toEqual(Buffer.from(image)); expect(f.fetch).not.toHaveBeenCalled();
});

it('accepts and edits the next file instruction while the original native turn acknowledgement is suspended', async () => {
    let release!: () => void, calls = 0;
    const pending = new Promise<void>(resolve => {release = resolve;});
    const f = await setup(['text'], () => ++calls === 1 ? pending : Promise.resolve());
    let queued: Promise<unknown> | undefined;
    try {
        const id = await f.runtime.sessionRepository.createSession('Native file queue');
        await f.runtime.commandBus.execute(SessionCommand.Bind, {sessionId: id});
        await f.runtime.commandBus.execute(SessionCommand.Send, {text: 'Hold acknowledgement', files: [], agentId: 'remote-agent'});
        await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
        queued = f.runtime.commandBus.execute(SessionCommand.Send, {text: 'Queued file',
            files: [{name: 'notes.txt', type: 'text/plain', fileRef: new Blob(['QUEUED_FILE_BODY'])}], agentId: 'remote-agent'});
        void queued.catch(() => {});
        await vi.waitFor(() => expect(f.runtime.sessionManager.getSnapshot().instructionQueue?.items).toHaveLength(2));
        const nextId = await queued;
        const queue = f.runtime.sessionManager.getSnapshot().instructionQueue!;
        await f.runtime.commandBus.execute(SessionCommand.EditInstructionQueue, {expectedRevision: queue.revision, action: 'update', id: nextId, text: 'Edited queued file'});
        expect(f.prompts).toHaveLength(1); release();
        await vi.waitFor(async () => {const rounds = (await f.runtime.sessionRepository.readHistoryChain(id)).rounds;
            expect(rounds).toHaveLength(2); expect(rounds.every(round => round.status === 'completed')).toBe(true);}, {timeout: 10000});
        expect(f.prompts[1]).toContain('Edited queued file');
        expect(f.attachments[1]).toMatchObject([{kind: 'text', content: 'QUEUED_FILE_BODY'}]); expect(f.fetch).not.toHaveBeenCalled();
    } finally {release(); await queued?.catch(() => {});}
}, 20000);
