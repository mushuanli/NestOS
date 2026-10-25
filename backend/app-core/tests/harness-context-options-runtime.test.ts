import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {SessionCommand, type ContextOptionsPage, type RootTargetCatalog} from '@itookit/llm-session/contracts';
import type {AgentDefinition} from '@itookit/kernel-adapters/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {contextOptionsFixture} from './harness-context-options-fixture';

type Runtime = Awaited<ReturnType<typeof createApplicationRuntime>>;
const runtimes: Runtime[] = [];
afterEach(async () => {vi.restoreAllMocks(); for (const runtime of runtimes.splice(0)) await runtime.dispose(); vi.unstubAllGlobals();});
async function setup() {
    vi.stubGlobal('fetch', vi.fn(async () => {throw new Error('Native and model network calls are forbidden');}));
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    runtimes.push(runtime);
    const definition: AgentDefinition = {id: 'native-target', name: 'Native', type: 'agent', config: {}, execution: {kind: 'harness', connectionId: 'native'}};
    await runtime.agentService.saveAgent(definition);
    const status = await runtime.agentService.getAgentPublicationStatus(definition.id);
    const revision = await runtime.agentService.publishAgent({agentId: definition.id, operationId: 'publish', expectedSourceDigest: status.sourceDigest,
        expectedRevisionDigest: status.draftDigest, expectedPublishedVersion: null});
    const sessionId = await runtime.sessionRepository.createSession('Passive context options');
    return {runtime, sessionId, target: revision.target};
}

it('queries an explicit unbound Session through the actual command port without opening Kernel writers or loading Skills', async () => {
    const f = await setup(), metadata = contextOptionsFixture().inspection;
    const inspect = vi.spyOn(f.runtime.executionConnections, 'inspect').mockResolvedValue(metadata);
    const freeze = vi.spyOn(f.runtime.executionConnections, 'freeze'), acquire = vi.spyOn(f.runtime.executionConnections, 'acquire');
    const open = vi.spyOn(f.runtime.kernel.kernel, 'openSession').mockRejectedValue(new Error('Passive query cannot activate Kernel Session'));
    const before = await f.runtime.sessionRepository.getLoadState(f.sessionId);
    const page = await f.runtime.commandBus.execute<ContextOptionsPage>(SessionCommand.ContextOptions,
        {sessionId: f.sessionId, branchId: 'main', target: f.target, overrides: {systemPromptAppend: 'Private one-call policy'}});
    expect(page).toMatchObject({kind: 'direct-harness', sources: [], dynamicPolicy: 'dispatch-validation-required'});
    expect(inspect).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled(); expect(freeze).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
    expect(await f.runtime.sessionRepository.getLoadState(f.sessionId)).toEqual(before);
    expect(f.runtime.sessionManager.getSnapshot().sessionId).not.toBe(f.sessionId);
    expect(JSON.stringify(page)).not.toContain('Private one-call policy'); expect(globalThis.fetch).not.toHaveBeenCalled();
});

it('keeps a normal legacy chat selectable and validates the destination before passive metadata inspection', async () => {
    const f = await setup(), inspect = vi.spyOn(f.runtime.executionConnections, 'inspect');
    await f.runtime.agentService.saveAgent({id: 'legacy-chat', name: 'Legacy', type: 'agent', config: {}});
    const targets = await f.runtime.commandBus.execute<RootTargetCatalog>(SessionCommand.ListTargets);
    const target = targets.entries.find(entry => entry.target.id === 'legacy-chat')!.target;
    expect(await f.runtime.commandBus.execute(SessionCommand.ContextOptions, {sessionId: f.sessionId, branchId: 'main', target}))
        .toMatchObject({kind: 'other', sources: [], modes: {new: {supported: false}, fork: {supported: false}, continue: {supported: false}}});
    await expect(f.runtime.commandBus.execute(SessionCommand.ContextOptions, {sessionId: f.sessionId, branchId: 'missing', target: f.target}))
        .rejects.toMatchObject({code: 'CONTEXT_QUERY_BRANCH_INVALID'});
    expect(inspect).not.toHaveBeenCalled();
});
