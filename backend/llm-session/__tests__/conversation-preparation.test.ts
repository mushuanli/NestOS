import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend, type IVFSManager} from '@itookit/vfs-core';
import {Kernel} from '@itookit/durable-kernel';
import {registerDurablePrograms, submitTaskCall} from '@itookit/llm-flow';
import {HarnessProgram, HarnessExecutionEffect} from '@itookit/kernel-adapters';
import {sha256HexSync} from '@itookit/llm-context';
import {prepareDirectConversationRun, type DirectConversationPreparationInput, type DirectConversationPreparationOptions} from '../src';
import {SessionRepository} from '../src/persistence/session-repository';
import {RoundLog} from '../src/persistence/round-log';
import {RoundGraphService} from '../src/persistence/round-graph-service';
import {ContextProfileStore} from '../src/persistence/context-profile-store';

let manager: IVFSManager, kernel: Kernel, repository: SessionRepository, sessionId: string, log: RoundLog;
const logger = {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()};
const model = vi.fn(async () => ({choices: [{message: {role: 'assistant', content: 'Finished'}, finish_reason: 'stop'}]}));
const native = vi.fn(async () => ({text: 'Remote finished', sessionId: 'native', turnId: 'turn'}));
beforeEach(async () => {
    ({manager} = await createVFS({rootBackend: new MemoryBackend()})); const fs = await manager.openFileSystem('/');
    kernel = new Kernel({catalog: {fs}, maxConcurrentEffects: 1});
    kernel.registerStorageResolver({kind: 'test', resolve: async ref => ({fs, rootPath: String(ref.locator)})});
    registerDurablePrograms(kernel); kernel.registerProgram(new HarnessProgram());
    kernel.registerEffect({kind: 'llm.chat', version: '1', execute: model});
    kernel.registerEffect(new HarnessExecutionEffect({execute: native, cancel: async (_request, context) => ({status: 'stopped', cleanup: 'confirmed',
        evidence: {sessionId: context.sessionId, taskId: context.taskId, effectId: context.effectId, ref: 'fixture', kind: 'terminal'}}),
        reconcile: async (_request, context) => ({status: 'not-started', evidence: {sessionId: context.sessionId,
            taskId: context.taskId, effectId: context.effectId, ref: 'fixture', kind: 'not-started'}})}));
    await kernel.initialize();
    repository = new SessionRepository(fs, async id => {await kernel.createSession({id, storage: {kind: 'test', locator: `/kernel/${id}`}});});
    await repository.init(); sessionId = await repository.createSession('Actual callee'); log = new RoundLog(repository, sessionId);
    await kernel.createSession({id: 'caller', storage: {kind: 'test', locator: '/kernel/caller'}});
    vi.clearAllMocks();
});
afterEach(async () => {vi.restoreAllMocks(); kernel.dispose(); await kernel.waitIdle(); await repository.dispose(); await manager.dispose();});
function input(): DirectConversationPreparationInput {
    return {task: {id: 'prepare-request', sessionId, input: {sessionId, agentId: 'reviewer', text: 'Current request', files: [],
        invocation: {invocationId: 'business-call'}, overrides: {executionMode: 'chat'}}}, log, roundId: 'round', contextFiles: [],
        config: {id: 'reviewer', name: 'Reviewer', type: 'agent', connectionId: 'model', systemPrompt: ['Agent rules'],
            stream: false, target: {kind: 'agent', id: 'reviewer', version: '1', digest: 'a'.repeat(64)}}};
}
function options(): DirectConversationPreparationOptions {
    return {engine: repository, loadArtifact: async () => null, hostPorts: {logger},
        hasProgram: (kind, version) => kernel.programs.has(kind, version)};
}
async function append(id: string, text: string) {
    const manifest = await log.loadManifest();
    await log.append('main', {id, sessionId, input: [{role: 'user', content: text}], output: [{role: 'assistant', content: `Reply ${text}`}],
        historyParentIds: manifest.currentHead ? [manifest.currentHead] : [], executions: [], status: 'completed', createdAt: Date.now(), origin: 'user'});
}
function nativeInput(): DirectConversationPreparationInput {
    const value = input(); value.config.execution = {kind: 'harness', connectionId: 'remote'};
    value.config.harnessConnection = {version: 1, revision: 1, id: 'remote', name: 'Remote', kind: 'harness',
        nodeConnectionId: 'node', projectId: 'project', profileId: 'claude', project: {root: '/workspace'}};
    return value;
}
it('assembles real scoped history and host rules without creating a Round, Task, model request or controller', async () => {
    await append('selected', 'Selected question'); const configured = options();
    configured.resolveSessionContext = async actual => {expect(actual).toBe(sessionId); return {projectInstructions: 'Project rules', skillInstructions: '', skillIndex: ''};};
    const prepared = await prepareDirectConversationRun(input(), configured), serialized = JSON.parse(JSON.stringify(prepared));
    expect(prepared.context).toMatchObject({branchRef: 'main', branchHead: 'selected', agent: {id: 'reviewer', version: '1'}});
    const messages = (prepared.definition.task.input as {messages: unknown[]}).messages;
    expect(messages).toEqual([{role: 'system', content: 'Agent rules'}, {role: 'system', content: 'Project rules'},
        {role: 'user', content: 'Selected question'}, {role: 'assistant', content: 'Reply Selected question'}, {role: 'user', content: 'Current request'}]);
    expect(prepared.context.digest).toBe(sha256HexSync(JSON.stringify(messages)));
    expect(serialized.definition).toEqual(JSON.parse(JSON.stringify(prepared.definition)));
    expect(await repository.listHistory(sessionId)).toHaveLength(1); expect(await kernel.listSessionTasks(sessionId)).toEqual([]);
    expect(model).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
});
it('keeps a frozen empty head and absent profile when the live branch later gains history and rules', async () => {
    const request = input(); request.task.frozen = {branchRef: 'main', branchHead: null};
    await append('later', 'Later history'); const profile = await new ContextProfileStore(repository, sessionId).createProfile();
    await new RoundGraphService(repository, sessionId).setContextProfile('main', profile.id, profile.revision);
    const prepared = await prepareDirectConversationRun(request, options());
    expect(prepared.context).toMatchObject({branchHead: null, profile: {id: '', revision: 0}});
    expect(JSON.stringify(prepared.definition)).not.toContain('Later history');
});
it('reads the admitted immutable profile revision instead of the live branch rules', async () => {
    await append('selected', 'Selected'); const profiles = new ContextProfileStore(repository, sessionId), base = await profiles.createProfile();
    const excluded = await profiles.updateProfile(base.id, base.revision, {selected: {mode: 'exclude', scope: 'node'}});
    const request = input(); request.task.frozen = {branchRef: 'main', branchHead: 'selected', contextProfile: {id: excluded.id, revision: excluded.revision}};
    await new RoundGraphService(repository, sessionId).setContextProfile('main', base.id, base.revision);
    const prepared = await prepareDirectConversationRun(request, options()); expect(prepared.context.profile.revision).toBe(excluded.revision);
    expect(JSON.stringify(prepared.definition)).not.toContain('Reply Selected');
});

it('uses explicit child material and scoped summary artifacts without importing parent history implicitly', async () => {
    await append('selected', 'Original history');
    const profiles = new ContextProfileStore(repository, sessionId), base = await profiles.createProfile();
    const summary = await profiles.updateProfile(base.id, base.revision, {selected: {mode: 'summary', artifactId: 'summary'}});
    const request = input(); request.task.frozen = {branchRef: 'main', branchHead: 'selected', contextProfile: {id: summary.id, revision: summary.revision}};
    const configured = options(); configured.loadArtifact = vi.fn(async (actual, id) => {
        expect(actual).toBe(sessionId); expect(id).toBe('summary');
        return {id, outputName: 'summary', type: 'summary' as const, content: 'Selected summary', contentHash: sha256HexSync('Selected summary'), createdAt: 1};
    });
    expect(JSON.stringify((await prepareDirectConversationRun(request, configured)).definition)).toContain('Selected summary');
    const child = await repository.createSession('Child', null, sessionId, undefined, {initialContext: {id: 'transfer', sessionId,
        captureId: 'capture', branch: 'main', head: 'selected', createdAt: 1, selection: {kind: 'text', text: 'Declared material'}, messageIds: [], value: 'Declared material'}});
    const childRequest = input(); childRequest.task.sessionId = childRequest.task.input.sessionId = child;
    childRequest.log = new RoundLog(repository, child);
    const prepared = await prepareDirectConversationRun(childRequest, options());
    expect(JSON.stringify(prepared.definition)).toContain('Declared material');
    expect(JSON.stringify(prepared.definition)).not.toContain('Original history');
    expect(await repository.listHistory(child)).toEqual([]);
});
it('freezes caller input, default tools, MCP, Skill and host policy before later asynchronous context work', async () => {
    const request = input(), configured = options(); request.task.input.overrides!.executionMode = 'agent';
    request.config.capabilityPolicy = {mcpProfileIds: ['server'], skillIds: ['review']};
    const tools = ['inspect'], skill = {id: 'review', name: 'Review', description: '', type: 'prompt' as const, enabled: true,
        instructions: 'Review instructions', triggerPatterns: [], autoLoad: false, priority: 0, compact: {rawContent: 'Keep checks', marker: 'Compact Instructions', redLines: []}, tools: [{toolId: 'inspect', definition: {name: 'inspect'}, executionType: 'handler' as const}]};
    configured.resolveHarnessToolIds = async actual => {expect(actual).toBe(sessionId); return tools;};
    configured.resolveMCPToolIds = async actual => {expect(actual).toBe(sessionId); return ['mcp__lookup'];};
    configured.resolveSkills = async () => [skill];
    let entered!: () => void, release!: () => void; const gate = new Promise<void>(resolve => {release = resolve;});
    const ready = new Promise<void>(resolve => {entered = resolve;});
    configured.resolveSessionContext = async () => {entered(); await gate; return {projectInstructions: '', skillInstructions: '', skillIndex: ''};};
    configured.resolveTools = async () => ({definitions: [{name: 'inspect'}, {name: 'mcp__lookup'}], externalIds: ['inspect']});
    configured.directAgentPolicy = {systemPrompt: ['Host policy'], maxExchanges: 3};
    const preparing = prepareDirectConversationRun(request, configured); await ready;
    request.task.id = 'changed-request'; request.task.sessionId = 'wrong-session';
    request.task.input.text = 'Changed input'; request.config.systemPrompt = ['Changed policy']; tools.push('outside');
    skill.compact.rawContent = 'Changed skill'; configured.directAgentPolicy.maxExchanges = 99; release();
    const prepared = await preparing, actual = prepared.definition.task.input;
    expect(actual).toMatchObject({allowedToolIds: ['inspect', 'mcp__lookup'], maxExchanges: 3,
        skillContexts: [{compactInstructions: 'Keep checks'}]});
    expect(JSON.stringify(actual)).toContain('Current request'); expect(JSON.stringify(actual)).not.toContain('Changed');
    expect(JSON.stringify(actual)).not.toContain('outside');
    expect(logger.info).toHaveBeenCalledWith('Direct run preparation', expect.objectContaining({operationId: 'prepare-request', sessionId}));
});
it.each(['chat', 'agent', 'harness'] as const)('hands hosted %s preparation through a JSON roundtrip to the owned Kernel path', async kind => {
    const request = kind === 'harness' ? nativeInput() : input(), configured = options();
    if (kind === 'agent') {request.task.input.overrides!.executionMode = 'agent'; configured.resolveHarnessToolIds = async () => ['inspect'];
        configured.resolveTools = async () => ({definitions: [{name: 'inspect'}], externalIds: []});}
    const prepared = JSON.parse(JSON.stringify(await prepareDirectConversationRun(request, configured)));
    configured.resolveTools = async () => {throw Error('Do not rebuild a frozen plan');};
    const run = await submitTaskCall(prepared.definition, {kernel, caller: {sessionId: 'caller', requestId: 'owned'}, maxDepth: 3, timeoutMs: null});
    expect(await run.root.wait({until: 'settled', timeoutMs: 3000})).toMatchObject({status: 'succeeded', output: {task: {sessionId},
        exit: {output: {message: {content: kind === 'harness' ? 'Remote finished' : 'Finished'}}}}});
    expect((await kernel.listSessionTasks(sessionId))[0].ownedBy).toMatchObject({sessionId: 'caller', taskId: run.root.id});
    expect(await repository.listHistory(sessionId)).toEqual([]);
});
it('materializes a verified native file from the actual callee before compilation and preserves its digest', async () => {
    const request = nativeInput(), blob = new Blob(['Document body'], {type: 'text/plain'});
    await repository.writeAttachment(sessionId, 'notes.txt', await blob.arrayBuffer());
    request.contextFiles = request.task.input.files = [{name: 'notes.txt', type: 'text/plain', size: blob.size,
        content: {sha256: sha256HexSync('Document body'), bytes: blob.size}}];
    const prepared = await prepareDirectConversationRun(request, options());
    expect(prepared.definition.task.input).toMatchObject({messages: expect.arrayContaining([
        expect.objectContaining({role: 'user', content: 'Current request', attachments: [expect.objectContaining({source: 'Document body'})]})])});
    expect(JSON.stringify(prepared)).not.toContain('abortController'); expect(native).not.toHaveBeenCalled();
    const missing = nativeInput(); missing.contextFiles = missing.task.input.files = [{name: 'missing.txt', type: 'text/plain', size: 1}];
    await expect(prepareDirectConversationRun(missing, options())).rejects.toHaveProperty('code', 'ATTACHMENT_NOT_FOUND');
    expect(await kernel.listSessionTasks(sessionId)).toEqual([]);
});
it.each(['scope', 'flow', 'skills', 'context', 'catalog', 'compile'] as const)('reports %s failure without payload and isolates diagnostic errors', async stage => {
    const request = input(), configured = options(); request.task.input.text = 'PRIVATE PAYLOAD';
    if (stage === 'scope') request.task.input.sessionId = 'foreign';
    if (stage === 'flow') request.config.type = 'flow';
    if (stage === 'skills') {request.config.capabilityPolicy = {skillIds: ['review'], mcpProfileIds: []}; configured.resolveSkills = async () => {throw Error('PRIVATE PAYLOAD');};}
    if (stage === 'context') configured.resolveSessionContext = async () => {throw Error('PRIVATE PAYLOAD');};
    if (stage === 'catalog') configured.resolveTools = async () => {throw Error('PRIVATE PAYLOAD');};
    if (stage === 'compile') {request.task.input.overrides!.executionMode = 'agent'; request.config.capabilityPolicy = {toolIds: [], mcpProfileIds: []};}
    await expect(prepareDirectConversationRun(request, configured)).rejects.toBeInstanceOf(Error);
    expect(logger.warn).toHaveBeenCalledWith('Direct run preparation', expect.objectContaining({operation: 'session.direct.prepare',
        outcome: 'failure', stage: {scope: 'input', flow: 'input', skills: 'tools-and-skills', context: 'context', catalog: 'tool-catalog', compile: 'compile'}[stage],
        operationId: 'prepare-request', errorCode: expect.any(String), durationMs: expect.any(Number)}));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE PAYLOAD');
    expect(await kernel.listSessionTasks(sessionId)).toEqual([]);
    configured.hostPorts!.logger = {...logger, warn: () => {throw Error('logger unavailable');}};
    await expect(prepareDirectConversationRun(request, configured)).rejects.not.toThrow('logger unavailable');
    const healthy = options(); healthy.hostPorts!.logger = {...logger, info: () => {throw Error('logger unavailable');}};
    expect((await prepareDirectConversationRun(input(), healthy)).definition.kind).toBe('task');
});

it('rejects malformed preparation identities without logging them as correlation data', async () => {
    const request = input(); request.task.id = {secret: 'PRIVATE BODY'} as never;
    await expect(prepareDirectConversationRun(request, options())).rejects.toHaveProperty('code', 'CALL_PREPARATION_SCOPE_MISMATCH');
    await expect(prepareDirectConversationRun(undefined as never, options())).rejects.toHaveProperty('code', 'CALL_PREPARATION_SCOPE_MISMATCH');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE BODY');
    expect(await kernel.listSessionTasks(sessionId)).toEqual([]);
});
