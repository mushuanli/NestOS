import {buildTool, TaskListTool, type Tool} from '@itookit/tools';
import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import type {FlowDraft} from '@itookit/llm-flow/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals();});
const text = '我喜欢 TypeScript。';

it('propagates the batch receipt from an actual durable Tool call into the scanner run', async () => {
    const tool = buildTool({name: 'fixture.batch-collector', version: '1', inputSchema: TaskListTool.inputSchema,
        async description() {return 'Batch collecting';}, async prompt() {return '';},
        async call() {return {data: {collection: {version: 1, complete: false, processed: 3}}};},
        mapToolResultToToolResultBlockParam(data, id) {return {type: 'tool_result', tool_use_id: id, content: JSON.stringify(data)};}});
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false,
        kernelPlatform: {additionalTools: [tool]}}); cleanup.push(() => runtime.dispose());
    const twin = runtime.digitalTwin!, target = (await twin.collectionTools()).find(item => item.target.id === tool.name)!.target;
    const plan = await twin.saveScanRule(null, null, {name: 'Batch collecting', collection: {target}, mode: 'collect',
        include: [], exclude: [], intervalMinutes: 30, enabled: true, trigger: 'manual'});
    const run = await twin.runScanPlan(plan); await twin.waitScanRun(run);
    expect((await twin.snapshot()).scans.runs.find(item => item.id === run)!.data.collectionProgress).toEqual({version: 1, complete: false, processed: 3});
}, 30000);

it('retains the specific failure code from a direct collector through the durable call and scanner report', async () => {
    const tool = buildTool({name: 'fixture.failing-collector', version: '1', inputSchema: TaskListTool.inputSchema,
        async description() {return 'Fail collecting';}, async prompt() {return '';},
        async call() {throw Object.assign(new Error('PRIVATE_FAILURE_DETAIL'), {code: 'RESOURCE_WRITE_DENIED'});},
        mapToolResultToToolResultBlockParam(data, id) {return {type: 'tool_result', tool_use_id: id, content: JSON.stringify(data)};}});
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false,
        kernelPlatform: {additionalTools: [tool]}}); cleanup.push(() => runtime.dispose());
    const twin = runtime.digitalTwin!, target = (await twin.collectionTools()).find(item => item.target.id === tool.name)!.target;
    const plan = await twin.saveScanRule(null, null, {name: 'Fail collecting', collection: {target}, mode: 'collect',
        include: [], exclude: [], intervalMinutes: 30, enabled: true, trigger: 'manual'});
    const run = await twin.runScanPlan(plan); await expect(twin.waitScanRun(run)).rejects.toThrow('TWIN_COLLECTION_FAILED');
    const record = (await twin.snapshot()).scans.runs.find(item => item.id === run)!;
    expect(record.data).toMatchObject({state: 'failed', error: 'TWIN_COLLECTION_FAILED', errorDetail: 'RESOURCE_WRITE_DENIED', spentTokens: 0});
    expect(record.data.errorDetail).not.toContain('PRIVATE_FAILURE_DETAIL');
}, 30000);
const result = {candidates: [{content: '偏好 TypeScript', kind: 'preference', subject: 'self', project: '', eventTime: '', quote: text}]};
async function setup(withOrganization = false, additionalTools: Tool[] = []) {
    const backend = new MemoryBackend(); await backend.init();
    for (const path of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(path);
    const write = (path: string, value: unknown) => backend.write(path, new TextEncoder().encode(JSON.stringify(value)));
    await write('/etc/llm/.providers/mock.json', {id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'fixture', baseURL: 'https://fixture.invalid', models: [{id: 'mock-model', name: 'Mock'}]});
    await write('/etc/llm/.connections/default.json', {id: 'default', name: 'Default', providerId: 'mock', protocol: 'openai-chat', tiers: {optimal: 'mock-model'}});
    await write('/etc/llm/.connection-settings.json', {defaultConnectionId: 'default'});
    const requests = vi.fn(async (_url: unknown, options: any) => {
        const body = JSON.parse(options.body), content = JSON.stringify(result), usage = {prompt_tokens: 50, completion_tokens: 50, total_tokens: 100};
        return body.stream ? new Response(`data: ${JSON.stringify({id: 'response', choices: [{index: 0, delta: {role: 'assistant', content}, finish_reason: 'stop'}], usage})}\n\ndata: [DONE]\n\n`, {headers: {'content-type': 'text/event-stream'}})
            : new Response(JSON.stringify({id: 'response', choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}], usage}), {headers: {'content-type': 'application/json'}});
    }); vi.stubGlobal('fetch', requests);
    const runtime = await createApplicationRuntime({backend, kernelPlatform: {additionalTools}, ownerKind: 'cli', digitalTwinAutoStart: false, ...(withOrganization ? {digitalTwinWorkspaces: [{twinId: 'team', ownerId: 'organization:team', name: 'Team', kind: 'organization' as const, authorize: async () => {}}]} : {})}); cleanup.push(() => runtime.dispose());
    const twin = runtime.digitalTwin!;
    await twin.configure({connectionId: 'default'}, (await twin.getSettings()).revision);
    return {runtime, twin, requests};
}
it('runs a published Flow from a text snapshot and accepts its supported result only after review', async () => {
    const {runtime, twin, requests} = await setup();
    const flow: FlowDraft = {id: 'scan-fixture' as never, name: 'Scan fixture', draftVersion: 1, updatedAt: 0, layout: {},
        parameters: [{name: 'text', type: 'string', required: true, role: 'input', inputSource: 'composer.text'}],
        nodes: [{id: 'result' as never, name: 'Result', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: result}}], edges: [],
        outputs: {result: {value: '${nodes.result.outputs.result}'}}};
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    const selected = (await twin.scannerTargets()).find(item => item.target.id === flow.id)!;
    const id = await twin.saveScanRule(null, null, {name: 'Published scanner', include: [], exclude: [], intervalMinutes: 30, trigger: 'manual', enabled: true,
        input: {kind: 'text', text}, executor: {target: selected.target}, autoConfirm: false});
    const run = await twin.runScanPlan(id); await twin.waitScanRun(run);
    const snapshot = await twin.snapshot(), candidate = snapshot.memories.find(item => item.data.content === result.candidates[0].content)!;
    expect(candidate.data.state).toBe('candidate'); expect(candidate.data.quote).toBe(text); expect(requests).not.toHaveBeenCalled();
    await twin.review(candidate.id, candidate.revision, 'confirm');
    expect((await twin.snapshot()).memories.find(item => item.id === candidate.id)!.data.state).toBe('active');
    expect(snapshot.metering.entries.find(entry => entry.planId === id)).toMatchObject({tokens: 0, usageKind: 'reported'});
}, 20000);
it('runs a published Agent through the same scanner and accounts model usage', async () => {
    const {runtime, twin, requests} = await setup();
    await runtime.agentService.saveAgent({id: 'scanner-agent', name: 'Scanner Agent', type: 'agent', config: {systemPrompt: 'Return candidates JSON with exact supporting quotes.'}});
    const state = await runtime.agentService.getAgentPublicationStatus('scanner-agent');
    await runtime.agentService.publishAgent({agentId: 'scanner-agent', operationId: 'publish-scanner', expectedSourceDigest: state.sourceDigest,
        expectedRevisionDigest: state.draftDigest, expectedPublishedVersion: state.latest?.target.version ?? null});
    const selected = (await twin.scannerTargets()).find(item => item.target.id === 'scanner-agent')!;
    const id = await twin.saveScanRule(null, null, {name: 'Agent scanner', include: [], exclude: [], intervalMinutes: 30, trigger: 'manual', enabled: true,
        input: {kind: 'text', text}, executor: {target: selected.target}, autoConfirm: false});
    await twin.waitScanRun(await twin.runScanPlan(id));
    expect(requests).toHaveBeenCalledTimes(1);
    expect((await twin.snapshot()).memories[0].data.state).toBe('candidate');
    expect((await twin.snapshot()).metering.entries.find(entry => entry.planId === id)).toMatchObject({tokens: 100, usageKind: 'reported'});
}, 20000);
it('rejects unsupported evidence and leaves the existing knowledge unchanged', async () => {
    const {runtime, twin, requests} = await setup();
    const flow: FlowDraft = {id: 'unsupported-evidence' as never, name: 'Invalid evidence', draftVersion: 1, updatedAt: 0, layout: {},
        parameters: [{name: 'text', type: 'string', inputSource: 'composer.text'}], edges: [],
        nodes: [{id: 'result' as never, name: 'Result', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
            config: {value: {candidates: [{...result.candidates[0], quote: 'invented evidence'}]}}}],
        outputs: {result: {value: '${nodes.result.outputs.result}'}}};
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    const selected = (await twin.scannerTargets()).find(item => item.target.id === flow.id)!;
    const id = await twin.saveScanRule(null, null, {name: 'Invalid scanner', include: [], exclude: [], intervalMinutes: 30, trigger: 'manual', enabled: true,
        input: {kind: 'text', text}, executor: {target: selected.target}});
    await expect(twin.waitScanRun(await twin.runScanPlan(id))).rejects.toThrow('TWIN_INVALID_EXTRACTION');
    expect((await twin.snapshot()).memories).toHaveLength(0);
    expect((await twin.snapshot()).metering.entries.find(entry => entry.planId === id)).toMatchObject({state: 'settled', tokens: 0});
    expect(requests).not.toHaveBeenCalled();
}, 20000);
it('runs an organization-owned published scanner without changing the personal workspace', async () => {
    const {runtime, twin} = await setup(true);
    const flow: FlowDraft = {id: 'org-scanner' as never, name: 'Organization scanner', draftVersion: 1, updatedAt: 0, layout: {},
        parameters: [{name: 'text', type: 'string', inputSource: 'composer.text'}], edges: [],
        nodes: [{id: 'result' as never, name: 'Result', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {value: result}}],
        outputs: {result: {value: '${nodes.result.outputs.result}'}}};
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    const opened = await twin.openWorkspace('team');
    const target = (await opened.scannerTargets()).find(item => item.target.id === flow.id)!.target;
    const id = await opened.saveScanRule(null, null, {name: 'Organization scanner', include: [], exclude: [], intervalMinutes: 30, enabled: true, trigger: 'manual',
        input: {kind: 'text', text}, executor: {target}});
    await opened.waitScanRun(await opened.runScanPlan(id));
    expect((await opened.snapshot()).memories).toHaveLength(1);
    expect((await opened.snapshot()).workspace).toMatchObject({id: 'team', kind: 'organization'});
    expect((await twin.snapshot()).memories).toHaveLength(0);
    expect((await twin.workspaces()).map(item => item.id)).toEqual(['personal', 'team']);
    await expect(twin.openWorkspace('not-authorized')).rejects.toThrow('TWIN_WORKSPACE_ACCESS_DENIED');
}, 20000);
it('reads a workspace file and invalidates earlier knowledge after its content changes', async () => {
    const {runtime, twin} = await setup();
    const fs = await runtime.vfs.openFileSystem('/');
    await fs.driver.createFile({parentPath: '/home/admin/notes', name: 'scanner-source.md', content: text, recursive: true});
    const id = await twin.saveScanRule(null, null, {name: 'File scanner', include: [], exclude: [], intervalMinutes: 30, trigger: 'manual', enabled: true,
        input: {kind: 'file', path: '/home/admin/notes/scanner-source.md'}, autoConfirm: false});
    await twin.waitScanRun(await twin.runScanPlan(id));
    const first = (await twin.snapshot()).memories[0]; expect(first.supported).toBe(true);
    await fs.driver.writeContent('/home/admin/notes/scanner-source.md', 'Changed content');
    await expect(twin.waitScanRun(await twin.runScanPlan(id))).rejects.toThrow('TWIN_INVALID_EXTRACTION');
    expect((await twin.snapshot()).memories.find(item => item.id === first.id)!.supported).toBe(false);
}, 20000);
it('cancels a running published Agent without accepting a late result or claiming unknown usage is free', async () => {
    const {runtime, twin, requests} = await setup();
    requests.mockImplementationOnce(async (_url, options: any) => new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, {once: true});
    }));
    await runtime.agentService.saveAgent({id: 'slow-scanner', name: 'Slow scanner', type: 'agent', config: {systemPrompt: 'Return candidate JSON.'}});
    const state = await runtime.agentService.getAgentPublicationStatus('slow-scanner');
    await runtime.agentService.publishAgent({agentId: 'slow-scanner', operationId: 'publish-slow', expectedSourceDigest: state.sourceDigest,
        expectedRevisionDigest: state.draftDigest, expectedPublishedVersion: state.latest?.target.version ?? null});
    const target = (await twin.scannerTargets()).find(item => item.target.id === 'slow-scanner')!.target;
    const id = await twin.saveScanRule(null, null, {name: 'Slow scanner', include: [], exclude: [], intervalMinutes: 30, enabled: true, trigger: 'manual',
        input: {kind: 'text', text}, executor: {target}});
    const run = await twin.runScanPlan(id), pending = twin.waitScanRun(run).catch(error => error);
    await vi.waitFor(() => expect(requests).toHaveBeenCalledTimes(1));
    await twin.cancelScanRun(run); await pending;
    const snapshot = await twin.snapshot();
    expect(snapshot.memories).toHaveLength(0);
    expect(snapshot.scans.runs.find(item => item.id === run)!.data.state).toBe('cancelled');
    expect(snapshot.jobs.find(item => item.data.scanScope?.runId === run)!.data.cancelConfirmed).toBe(true);
    expect(snapshot.metering.entries.find(entry => entry.planId === id)).toMatchObject({state: 'pending'});
}, 20000);

it('uses the remaining run budget for subsequent sources after settling the first model call', async () => {
    const {runtime, twin, requests} = await setup();
    await runtime.agentService.saveAgent({id: 'batch-scanner', name: 'Batch scanner', type: 'agent', config: {systemPrompt: 'Return candidates JSON with exact quotes.'}});
    const state = await runtime.agentService.getAgentPublicationStatus('batch-scanner');
    await runtime.agentService.publishAgent({agentId: 'batch-scanner', operationId: 'publish-batch', expectedSourceDigest: state.sourceDigest,
        expectedRevisionDigest: state.draftDigest, expectedPublishedVersion: state.latest?.target.version ?? null});
    const target = (await twin.scannerTargets()).find(item => item.target.id === 'batch-scanner')!.target;
    const fs = await runtime.vfs.openFileSystem('/'), sourceIds: string[] = [];
    for (const name of ['batch-a.md', 'batch-b.md']) {
        await fs.driver.createFile({parentPath: '/home/admin/notes', name, content: text, recursive: true});
        sourceIds.push(await twin.addSource({kind: 'file', target: '/home/admin/notes/' + name, label: name}, 'default'));
    }
    const id = await twin.saveScanPlan(null, null, {name: 'Batch scanner', sourceIds, connectionId: 'default', executor: {target},
        kinds: ['preference'], mode: 'analyze', trigger: 'manual', intervalMinutes: 30, tokenLimit: 100000, runTokenLimit: 50000, enabled: true});
    const runId = await twin.runScanPlan(id); await twin.waitScanRun(runId);
    expect(requests).toHaveBeenCalledTimes(2);
    expect((await twin.snapshot()).scans.runs.find(item => item.id === runId)!.data).toMatchObject({state: 'succeeded', spentTokens: 200, reservedTokens: 0});
}, 20000);

it('collects workspace evidence with a published Tool Flow before discovery and enforces the extraction output cap', async () => {
    const collected = vi.fn();
    const tool = buildTool({name: 'fixture.collect', version: '1', inputSchema: TaskListTool.inputSchema, maxResultSizeChars: 1000,
        async description() {return 'Collect fixture evidence';}, async prompt() {return '';},
        async call(_args, context) {
            collected(); await context.vfs!.writeFile('evidence/source.md', text); return {data: {count: 1}};
        }, mapToolResultToToolResultBlockParam(data, id) {return {type: 'tool_result', tool_use_id: id, content: JSON.stringify(data)};}});
    const {runtime, twin, requests} = await setup(false, [tool]);
    await runtime.projects.personal();
    const flow: FlowDraft = {id: 'collect-fixture' as never, name: 'Collect fixture', draftVersion: 1, updatedAt: 0, layout: {}, parameters: [],
        nodes: [{id: 'collect' as never, name: 'Collect', plugin: 'builtin.tool', pluginVersion: '1.0.0', inputs: {}, capabilities: ['fixture.collect'],
            config: {toolId: 'fixture.collect', toolVersion: '1', approval: 'none', args: {}}}], edges: [], outputs: {result: {value: '${nodes.collect.outputs.result}'}}};
    await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
    const target = (await twin.scannerTargets()).find(item => item.target.id === flow.id)!.target;
    const id = await twin.saveScanRule(null, null, {name: 'Collect and learn', collection: {target}, include: ['file:**/evidence/*.md'], exclude: [],
        trigger: 'manual', intervalMinutes: 30, enabled: true, autoConfirm: false, maxOutputTokens: 512});
    const run = await twin.runScanPlan(id); await twin.waitScanRun(run);
    expect(collected).toHaveBeenCalledTimes(1);
    const snapshot = await twin.snapshot();
    expect(snapshot.memories.some(memory => memory.data.quote === text && memory.data.state === 'candidate')).toBe(true);
    expect(snapshot.scans.runs.find(item => item.id === run)!.data.sourceIds.length).toBeGreaterThan(0);
    expect(requests).toHaveBeenCalled();
    expect(JSON.parse(requests.mock.calls[0][1].body).max_tokens).toBe(512);
}, 30000);

it.each([false, true])('collects with a direct Tool without a Flow or model connection (organization=%s)', async organization => {
    const collected = vi.fn();
    const tool = buildTool({name: 'fixture.direct-collect', version: '1', inputSchema: TaskListTool.inputSchema,
        async description() {return 'Collect direct evidence';}, async prompt() {return '';},
        async call(_args, context) {collected(); await context.vfs!.writeFile('evidence/direct.md', text); return {data: {count: 1}};},
        mapToolResultToToolResultBlockParam(data, id) {return {type: 'tool_result', tool_use_id: id, content: JSON.stringify(data)};}});
    const requests = vi.fn(); vi.stubGlobal('fetch', requests);
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false,
        digitalTwinWorkspaces: [{twinId: 'team', ownerId: 'organization:team', kind: 'organization', authorize: async () => {}}],
        kernelPlatform: {additionalTools: [tool]}}); cleanup.push(() => runtime.dispose());
    const twin = organization ? await runtime.digitalTwin!.openWorkspace('team') : runtime.digitalTwin!; await runtime.projects.personal();
    expect((await twin.getSettings()).data.connectionId).toBe('');
    const target = (await twin.collectionTools()).find(item => item.target.id === tool.name)!.target;
    const id = await twin.saveScanRule(null, null, {name: 'Direct collector', collection: {target}, mode: 'collect', include: [], exclude: [],
        trigger: 'event', intervalMinutes: 30, enabled: true});
    const first = await twin.triggerScanPlan(id, 'event-a');
    expect(await twin.triggerScanPlan(id, 'event-a')).toBe(first);
    await twin.waitScanRun(first);
    expect(await twin.triggerScanPlan(id, 'event-a')).toBe(first);
    expect(collected).toHaveBeenCalledTimes(1); expect(requests).not.toHaveBeenCalled();
    const snapshot = await twin.snapshot();
    expect(snapshot.jobs).toHaveLength(0); expect(snapshot.memories).toHaveLength(0);
    expect(snapshot.scans.runs.find(item => item.id === first)!.data).toMatchObject({state: 'succeeded', mode: 'collect', spentTokens: 0});
    const tasks = await runtime.kernel.kernel.listSessionTasks('twin-collection-' + first + '-tool');
    expect(tasks.some(task => task.program.kind === 'kernel-adapters.tool')).toBe(true);
    expect(tasks.some(task => task.program.kind === 'flow.aggregate')).toBe(false);
    expect((await runtime.digitalTwin!.snapshot()).scans.runs.some(item => item.id === first)).toBe(!organization);
}, 30000);

it('rechecks collection authority after acquiring the Session capability and before calling the Tool', async () => {
    const invoked = vi.fn(async () => ({data: {count: 1}})); let allowed = true;
    const tool = buildTool({name: 'fixture.authorized-collect', version: '1', inputSchema: TaskListTool.inputSchema, isReadOnly: () => true,
        async description() {return 'Collect evidence';}, async prompt() {return '';}, call: invoked,
        mapToolResultToToolResultBlockParam(data, id) {return {type: 'tool_result', tool_use_id: id, content: JSON.stringify(data)};}});
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false,
        digitalTwinWorkspace: {twinId: 'scoped', ownerId: 'owner', authorize: async () => {if (!allowed) throw new Error('Revoked');}},
        kernelPlatform: {additionalTools: [tool], configureSession: id => {if (id.endsWith('-tool')) allowed = false;}}});
    cleanup.push(() => runtime.dispose()); const twin = runtime.digitalTwin!;
    const target = (await twin.collectionTools()).find(item => item.target.id === tool.name)!.target;
    const id = await twin.saveScanRule(null, null, {name: 'Scoped collector', collection: {target}, mode: 'collect',
        include: [], exclude: [], intervalMinutes: 30, enabled: true, trigger: 'manual'});
    const run = await twin.runScanPlan(id);
    try {await expect(twin.waitScanRun(run)).rejects.toThrow('TWIN_COLLECTION_FAILED');}
    finally {allowed = true;}
    expect(invoked).not.toHaveBeenCalled();
    expect((await twin.snapshot()).scans.runs.find(item => item.id === run)!.data.state).toBe('failed');
}, 30000);

it('collects and learns directly from a Tool, then skips model work for unchanged material', async () => {
    const collected = vi.fn();
    const tool = buildTool({name: 'fixture.collect-learn', version: '1', inputSchema: TaskListTool.inputSchema,
        async description() {return 'Collect learning evidence';}, async prompt() {return '';},
        async call(_args, context) {collected(); await context.vfs!.writeFile('evidence/direct-learning.md', text); return {data: {count: 1}};},
        mapToolResultToToolResultBlockParam(data, id) {return {type: 'tool_result', tool_use_id: id, content: JSON.stringify(data)};}});
    const {runtime, twin, requests} = await setup(false, [tool]); await runtime.projects.personal();
    const target = (await twin.collectionTools()).find(item => item.target.id === tool.name)!.target;
    const id = await twin.saveScanRule(null, null, {name: 'Direct learning', collection: {target}, mode: 'analyze',
        include: ['file:**/evidence/*.md'], exclude: [], intervalMinutes: 30, trigger: 'manual', enabled: true, autoConfirm: false});
    await twin.waitScanRun(await twin.runScanPlan(id));
    const first = await twin.snapshot();
    expect(first.memories).toHaveLength(1); expect(first.memories[0].data.state).toBe('candidate');
    expect(requests).toHaveBeenCalledTimes(1);
    await twin.waitScanRun(await twin.runScanPlan(id));
    expect(collected).toHaveBeenCalledTimes(2); expect(requests).toHaveBeenCalledTimes(1);
    expect((await twin.snapshot()).memories).toHaveLength(1);
}, 30000);
