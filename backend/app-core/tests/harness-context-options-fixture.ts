import {vi} from 'vitest';
import type {ContextBinding, AgentPublishedRevision} from '@itookit/kernel-adapters/contracts';
import {directHarnessContextIdentity, type ContextOptionsQuery} from '@itookit/llm-session/contracts';
import {createContextOptionsReader} from '../src/projects/harness-context-options';
import {HarnessContextBindings} from '../src/projects/harness-context-bindings';
import type {HarnessConnectionInspection} from '../src/projects/harness-connections';
import {durableState, request} from './harness-execution-fixture';
import {context, operation} from './harness-context-fixture';

export function contextOptionsFixture() {
    const storage = durableState();
    const target = {kind: 'agent' as const, id: 'published', version: `ap1_${'a'.repeat(64)}`, digest: 'a'.repeat(64)};
    const definition = {id: target.id, name: 'Published', type: 'agent' as const, config: {}, execution: {kind: 'harness' as const, connectionId: request.connection.id}};
    const publication: AgentPublishedRevision = {schemaVersion: 1, definition, sourceDigest: 'a'.repeat(64), target, createdAt: 1};
    const inspection: HarnessConnectionInspection = {snapshot: request.connection, epoch: 'native-epoch', workspaceId: 'workspace', checkpointFork: true,
        profile: {id: 'claude', kind: 'fixture', projectRuntime: true, workspaces: [{id: 'workspace'}],
            capabilities: {create: true, history: true, interrupt: true, resume: true, interactions: true, fork: true, checkpointFork: true}}};
    const state = {manifest: {branches: {main: null, destination: null}, branchMeta: {}, currentBranch: 'main'}, settings: {executionMode: 'chat'}} as any;
    const agents = {getAgentConfig: vi.fn(async (_id: string) => structuredClone(definition)), getAgentRevision: vi.fn(async (_id: string, _version?: string) => structuredClone(publication))};
    const inspect = vi.fn(async (_id: string) => structuredClone(inspection)), sessions = {getLoadState: vi.fn(async (_id: string) => structuredClone(state))};
    const inspectSession = vi.fn(async (_id: string) => ({getShared: storage.state.get}));
    const reader = createContextOptionsReader({kernel: {inspectSession}, agents, sessions, connections: {inspect}});
    const query: ContextOptionsQuery = {sessionId: 's', branchId: 'destination', target};
    return {...storage, target, definition, publication, inspection, state, agents, inspect, inspectSession, sessions, reader, query,
        store: new HarnessContextBindings(storage.state, 's')};
}
export async function addContextSource(f: ReturnType<typeof contextOptionsFixture>, id: string, patch: Partial<ContextBinding> = {}) {
    const identity = directHarnessContextIdentity(f.target, f.inspection.snapshot.project);
    const owner = {...operation, operationId: `operation-${id}`, invocationId: `invocation-${id}`};
    await f.store.claim(id, {...context, ...identity, invocationId: owner.invocationId, branchId: 'main'}, f.inspection.snapshot, owner);
    await f.store.attach(id, owner.operationId, {nodeConnectionId: f.inspection.snapshot.nodeConnectionId,
        profileId: f.inspection.profile.id, workspaceId: f.inspection.workspaceId, epoch: f.inspection.epoch, sessionId: `private-thread-${id}`});
    const staged = await f.store.prepareSettlement(id, owner.operationId, {operationId: owner.operationId, kind: 'terminal', knownHeadRef: `checkpoint-${id}`});
    await f.store.release(id, owner.operationId, staged.revision + 1);
    Object.assign((f.records.get('harness.context.bindings')!.value as any).bindings[id], patch);
}
