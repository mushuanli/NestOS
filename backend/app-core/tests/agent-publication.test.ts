import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {FlowLibraryCommand} from '@itookit/app-contracts';
import {FlowCommand, type FlowDraft} from '@itookit/llm-flow/contracts';
import {SessionCommand, type SessionInstructionQueue} from '@itookit/llm-session/contracts';
import type {AgentDefinition, AgentPublishRequest} from '@itookit/kernel-adapters/contracts';
import {AgentResolver} from '@itookit/llm-session';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {createChatConfigurationView} from '../src/configuration/chat-configuration';

type Runtime = Awaited<ReturnType<typeof createApplicationRuntime>>;
const cleanup: Runtime[] = [];
const retainedBackends: MemoryBackend[] = [];
afterEach(async () => {for (const runtime of cleanup.splice(0)) await runtime.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const backend of retainedBackends.splice(0)) await backend.close();});
async function setup(backend = new MemoryBackend()) {
    const runtime = await createApplicationRuntime({backend, ownerKind: 'cli', digitalTwinAutoStart: false}); cleanup.push(runtime);
    await runtime.agentService.saveSystemPrompt({id: 'policy', name: 'Policy', content: ['LIBRARY_POLICY_1']});
    const definition: AgentDefinition = {id: 'published', name: 'Published Agent', type: 'agent', version: 'legacy-v1',
        config: {systemPromptId: 'policy', systemPrompt: 'INLINE_POLICY_1'}};
    await runtime.agentService.saveAgent(definition); return {runtime, backend, definition};
}
async function request(runtime: Runtime, operationId = 'publish-one'): Promise<AgentPublishRequest> {
    const state = await runtime.agentService.getAgentPublicationStatus('published');
    return {agentId: 'published', operationId, expectedSourceDigest: state.sourceDigest, expectedRevisionDigest: state.draftDigest,
        expectedPublishedVersion: state.latest?.target.version ?? null};
}
const flow = (): FlowDraft => ({id: 'implementation' as never, name: 'Implementation', draftVersion: 1, updatedAt: 0,
    parameters: [{name: 'request', type: 'string', required: true}, {name: 'mode', type: 'string', default: 'flow-default'}],
    nodes: [{id: 'value' as never, name: 'Value', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
        config: {value: {marker: 'FLOW_1', request: '${param.request}', mode: '${param.mode}'}}}], edges: [], outputs: {result: {value: '${nodes.value.outputs.result}'}}});

it('separates a published Agent from later draft and shared-prompt edits while preserving exact old revision reads', async () => {
    const {runtime, definition} = await setup(), originalRequest = await request(runtime), first = await runtime.agentService.publishAgent(originalRequest);
    const resolver = new AgentResolver(runtime.agentService);
    await runtime.agentService.saveAgent({...definition, name: 'Edited draft', config: {...definition.config, systemPrompt: 'INLINE_POLICY_2'}});
    await runtime.agentService.saveSystemPrompt({id: 'policy', name: 'Policy', content: ['LIBRARY_POLICY_2']});
    expect((await resolver.resolve('published')).systemPrompt).toEqual(['LIBRARY_POLICY_1', 'INLINE_POLICY_1']);
    expect((await resolver.getAvailableAgents()).find(agent => agent.id === 'published')?.name).toBe('Published Agent');
    expect((await runtime.agentService.getAgentPublicationStatus('published')).hasDraftChanges).toBe(true);
    const next = await runtime.agentService.publishAgent(await request(runtime, 'publish-two'));
    expect(next.target.version).not.toBe(first.target.version);
    expect((await resolver.resolveExact('published', first.target.version)).systemPrompt).toEqual(['LIBRARY_POLICY_1', 'INLINE_POLICY_1']);
    expect((await resolver.resolve('published')).systemPrompt).toEqual(['LIBRARY_POLICY_2', 'INLINE_POLICY_2']);
    expect(await runtime.agentService.publishAgent(originalRequest)).toEqual(first);
    expect((await runtime.agentService.getAgentRevision('published'))?.target).toEqual(next.target);
});

it('rejects source and dependency drift against the reviewed publication request before moving its pointer', async () => {
    const {runtime, definition} = await setup(), sourceRequest = await request(runtime);
    const path = runtime.agentService.getAgentResourceId('published')!;
    await runtime.agentService.engine.driver.writeContent(path, JSON.stringify({...definition, name: 'External draft edit'}));
    await expect(runtime.agentService.publishAgent(sourceRequest)).rejects.toMatchObject({code: 'AGENT_SOURCE_CHANGED', outcome: 'not-committed'});
    const dependencyRequest = await request(runtime, 'dependency-change');
    await runtime.agentService.saveSystemPrompt({id: 'policy', name: 'Policy', content: ['NEW_LIBRARY']});
    await expect(runtime.agentService.publishAgent(dependencyRequest)).rejects.toMatchObject({code: 'AGENT_PUBLICATION_DEPENDENCY_CHANGED', outcome: 'not-committed'});
    expect(await runtime.agentService.getAgentRevision('published')).toBeNull();
});

it('reads the persisted prompt for publication rather than adopting a stale presentation cache', async () => {
    const {runtime} = await setup(), req = await request(runtime);
    vi.spyOn(runtime.agentService, 'getSystemPrompt').mockResolvedValue({id: 'policy', name: 'Cached', content: ['STALE_POLICY']});
    await runtime.agentService.engine.driver.writeContent('/system-prompts/policy.sp', JSON.stringify({id: 'policy', name: 'Policy', content: ['PERSISTED_POLICY']}));
    await expect(runtime.agentService.publishAgent(req)).rejects.toMatchObject({code: 'AGENT_PUBLICATION_DEPENDENCY_CHANGED'});
    const published = await runtime.agentService.publishAgent(await request(runtime, 'fresh-prompt'));
    expect(published.systemPrompt?.content).toEqual(['PERSISTED_POLICY']);
    expect((await new AgentResolver(runtime.agentService).resolve('published')).systemPrompt).toEqual(['PERSISTED_POLICY', 'INLINE_POLICY_1']);
});

it('keeps an unchanged policy at the same published version after incidental source timestamp updates', async () => {
    const {runtime, definition} = await setup(), first = await runtime.agentService.publishAgent(await request(runtime));
    await runtime.agentService.saveAgent({...definition, modifiedAt: Date.now() + 1000});
    expect((await runtime.agentService.getAgentPublicationStatus('published')).hasDraftChanges).toBe(false);
    const same = await runtime.agentService.publishAgent(await request(runtime, 'same-content'));
    expect(same.target).toEqual(first.target); expect(same.createdAt).toBe(first.createdAt);
});

it('locks a published Flow implementation and defaults across later Flow/Agent edits and exact root calls', async () => {
    const {runtime, definition} = await setup(); await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow()]});
    await runtime.agentService.saveAgent({...definition, type: 'workflow', execution: {kind: 'flow', flowId: 'implementation', parameters: {mode: 'agent-default'}}});
    const first = await runtime.agentService.publishAgent(await request(runtime)); expect(first.flow?.revision).toBe(1);
    const draft = await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, {id: 'implementation'});
    (draft.nodes[0].config as any).value.marker = 'FLOW_2';
    const saved = await runtime.commandBus.execute<{draft: FlowDraft}>(FlowCommand.DraftSave, {draft, expectedDraftVersion: draft.draftVersion});
    await runtime.commandBus.execute(FlowCommand.RevisionCreate, {draftId: 'implementation', expectedDraftVersion: saved.draft.draftVersion});
    const sessionId = await runtime.sessionRepository.createSession('Published Flow Agent'); await runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await runtime.commandBus.execute(SessionCommand.Send, {agentId: 'published', text: 'Selected input', files: [], overrides: {flowParameters: {request: 'Selected input'}}});
    await vi.waitFor(async () => expect((await runtime.sessionRepository.readHistoryChain(sessionId)).rounds[0]?.status).toBe('completed'));
    const root = (await runtime.kernel.kernel.listSessionTasks(sessionId)).find(task => task.labels?.kind === 'flow-root')!;
    expect(JSON.stringify(root.output)).toContain('FLOW_1'); expect(JSON.stringify(root.output)).toContain('agent-default');
    const next = await runtime.agentService.publishAgent(await request(runtime, 'new-flow')); expect(next.flow?.revision).toBe(2);
    expect((await new AgentResolver(runtime.agentService).resolveExact('published', first.target.version)).execution).toMatchObject({kind: 'flow', revision: 1});

});

it('rejects a legacy Flow implementation override under a published Agent identity before admitting execution', async () => {
    const {runtime} = await setup(); await runtime.agentService.publishAgent(await request(runtime));
    const sessionId = await runtime.sessionRepository.createSession('Override rejection'); await runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await expect(runtime.commandBus.execute(SessionCommand.Send, {agentId: 'published', text: 'Do not run another implementation', files: [],
        sendIntent: {branch: {mode: 'continue'}, retention: {mode: 'persistent'}, execution: {kind: 'flow', flowId: 'different-flow', revision: 1}}}))
        .rejects.toMatchObject({code: 'AGENT_IMPLEMENTATION_OVERRIDE'});
    expect(await runtime.kernel.kernel.listSessionTasks(sessionId)).toEqual([]);
    expect((await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue)).items).toEqual([]);
});

it('keeps local scope and chat metadata tied to the published revision until another explicit publication', async () => {
    const {runtime, definition} = await setup(), first = await runtime.agentService.publishAgent(await request(runtime));
    await runtime.agentService.saveAgent({...definition, name: 'Unpublished name', exposure: 'local'});
    const view = await createChatConfigurationView(runtime.agentService);
    try {expect(view.getConfigurationSnapshot().agents.find(agent => agent.id === 'published')?.name).toBe(first.definition.name);}
    finally {await view.dispose();}
    await runtime.agentService.publishAgent(await request(runtime, 'private-publication'));
    expect((await new AgentResolver(runtime.agentService).getAvailableAgents()).some(agent => agent.id === 'published')).toBe(false);
    const sessionId = await runtime.sessionRepository.createSession('Local scope'); await runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await expect(runtime.commandBus.execute(SessionCommand.Send, {agentId: 'published', text: 'Rejected', files: []}))
        .rejects.toMatchObject({code: 'CALLABLE_LOCAL_ONLY'});
    expect((await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue)).items).toEqual([]);
});

it('retains published records after source deletion while rejecting new execution of the deleted resource', async () => {
    const {runtime} = await setup(), req = await request(runtime), first = await runtime.agentService.publishAgent(req);
    await runtime.agentService.deleteAgent('published');
    expect(await runtime.agentService.getAgentRevision('published', first.target.version)).toEqual(first);
    expect(await runtime.agentService.publishAgent(req)).toEqual(first);
    await expect(new AgentResolver(runtime.agentService).resolveExact('published', first.target.version)).rejects.toMatchObject({code: 'AGENT_NOT_FOUND'});
    await expect(new AgentResolver(runtime.agentService).resolve('published')).rejects.toMatchObject({code: 'AGENT_NOT_FOUND'});
});

it('does not recreate a deleted published default Agent through the legacy synthetic fallback', async () => {
    const {runtime, definition} = await setup(); await runtime.agentService.saveAgent({...definition, id: 'default'});
    const state = await runtime.agentService.getAgentPublicationStatus('default');
    await runtime.agentService.publishAgent({agentId: 'default', operationId: 'default-publication', expectedSourceDigest: state.sourceDigest,
        expectedRevisionDigest: state.draftDigest, expectedPublishedVersion: null});
    await runtime.agentService.deleteAgent('default');
    expect(await runtime.agentService.getAgentConfig('default')).toBeNull();
    await expect(new AgentResolver(runtime.agentService).resolve('default')).rejects.toMatchObject({code: 'AGENT_NOT_FOUND'});
    expect((await new AgentResolver(runtime.agentService).getAvailableAgents()).some(agent => agent.id === 'default')).toBe(false);
    const view = await createChatConfigurationView(runtime.agentService);
    try {expect(view.getConfigurationSnapshot().fallbackAgentAllowed).toBe(false);} finally {await view.dispose();}
});

it.each([true, false])('freezes ordinary Agent policy across restart and first publication (initiallyPublished=%s)', async initiallyPublished => {
    const observed: Array<{messages: Array<{role: string; content: unknown}>}> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        observed.push(JSON.parse(init.body));
        return new Response(JSON.stringify({id: 'completion', object: 'chat.completion', created: 1, model: 'mock-model',
            choices: [{index: 0, message: {role: 'assistant', content: 'Done'}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}}), {headers: {'content-type': 'application/json'}});
    }));
    const f = await setup(); let runtime = f.runtime;
    await runtime.agentService.saveProvider({id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'fixture-key',
        baseURL: 'http://localhost:18449', models: [{id: 'mock-model', name: 'Mock'}]});
    await runtime.agentService.saveConnection({id: 'mock', name: 'Mock', providerId: 'mock', tiers: {standard: 'mock-model'}});
    await runtime.agentService.setDefaultConnection('mock');
    vi.spyOn(f.backend, 'close').mockResolvedValue(undefined); retainedBackends.push(f.backend);
    if (initiallyPublished) await runtime.agentService.publishAgent(await request(runtime));
    const sessionId = await runtime.sessionRepository.createSession('Frozen policy');
    await runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    const initial = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    await runtime.commandBus.execute(SessionCommand.EditInstructionQueue, {action: 'pause', expectedRevision: initial.revision});
    const send = (text: string) => ({agentId: 'published', text, files: [], overrides: {executionMode: 'chat' as const, streamMode: false, webSearchEnabled: false}});
    await runtime.commandBus.execute(SessionCommand.Send, send('First request'));
    await runtime.agentService.saveAgent({...f.definition, config: {systemPrompt: 'SECOND_POLICY'}});
    await runtime.agentService.publishAgent(await request(runtime, 'next-model-policy'));
    await runtime.agentService.saveAgent({...f.definition, config: {systemPrompt: 'UNPUBLISHED_POLICY'}});
    cleanup.splice(cleanup.indexOf(runtime), 1); await runtime.dispose();
    runtime = await createApplicationRuntime({backend: f.backend, ownerKind: 'cli', digitalTwinAutoStart: false}); cleanup.push(runtime);
    await runtime.commandBus.execute(SessionCommand.Bind, {sessionId});
    await runtime.commandBus.execute(SessionCommand.Send, send('Second request'));
    const queue = await runtime.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
    expect(queue.items).toHaveLength(2); expect(observed).toHaveLength(0);
    await runtime.commandBus.execute(SessionCommand.EditInstructionQueue, {action: 'resume', expectedRevision: queue.revision});
    await vi.waitFor(async () => {
        const history = await runtime.sessionRepository.readHistoryChain(sessionId);
        expect(history.rounds).toHaveLength(2); expect(history.rounds.every(round => round.status === 'completed')).toBe(true);
    }, {timeout: 10000});
    expect(observed).toHaveLength(2);
    const policies = observed.map(call => JSON.stringify(call.messages.filter(message => message.role === 'system')));
    expect(policies[0]).toContain('INLINE_POLICY_1'); expect(policies[0]).toContain('LIBRARY_POLICY_1');
    expect(policies[0]).not.toContain('SECOND_POLICY'); expect(policies[1]).toContain('SECOND_POLICY');
    expect(policies.join('')).not.toContain('UNPUBLISHED_POLICY');
});
