import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import type {FlowDraft} from '@itookit/llm-flow/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals();});
const text = '我喜欢 TypeScript。';
const result = {candidates: [{content: '偏好 TypeScript', kind: 'preference', subject: 'self', project: '', eventTime: '', quote: text}]};
async function setup(withOrganization = false) {
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
    const runtime = await createApplicationRuntime({backend, ownerKind: 'cli', digitalTwinAutoStart: false, ...(withOrganization ? {digitalTwinWorkspaces: [{twinId: 'team', ownerId: 'organization:team', name: 'Team', kind: 'organization' as const, authorize: async () => {}}]} : {})}); cleanup.push(() => runtime.dispose());
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
