import {createModuleLogger, randomUUID} from '@itookit/common';
import type {ContextBinding} from '@itookit/kernel-adapters/contracts';
import {publishedAgentDefinition} from '@itookit/kernel-adapters/contracts';
import {assertRootCallable, sameTargetRef} from '@itookit/llm-flow/contracts';
import type {SessionRepository, VFSAgentService} from '@itookit/llm-session';
import {assertContextOptionsQuery, directHarnessContextIdentity, type ContextOptionsQuery, type ContextOptionsPage,
    type ContextOptionsReader, type ContextBindingPage} from '@itookit/llm-session/contracts';
import {contextBindingCheckpoints, contextBindingSummary, contextCheckpointSummary, projectContextBindingPage,
    readContextCatalog, type ContextInspector} from './harness-context-catalog';
import type {HarnessConnectionService, HarnessConnectionInspection} from './harness-connections';
import {checkpointForkSupported, contextOptionsBasis, qualifyContextCheckpoint, qualifyContextSource} from './harness-context-options-policy';
import {executionError} from './harness-execution-journal';

const log = createModuleLogger('ContextOptions');
export interface ContextOptionsReaderOptions {
    kernel: ContextInspector;
    agents: Pick<VFSAgentService, 'getAgentConfig' | 'getAgentRevision'>;
    sessions: Pick<SessionRepository, 'getLoadState'>;
    connections?: Pick<HarnessConnectionService, 'inspect'>;
}
export function createContextOptionsReader(options: ContextOptionsReaderOptions): ContextOptionsReader {
    return async supplied => {
        const started = Date.now(), operationId = randomUUID(); let stage = 'validate';
        try {
            assertContextOptionsQuery(supplied); const query = structuredClone(supplied);
            stage = 'destination'; const destination = await options.sessions.getLoadState(query.sessionId);
            if (!Object.hasOwn(destination.manifest.branches, query.branchId)) throw executionError('CONTEXT_QUERY_BRANCH_INVALID');
            stage = 'target'; const connectionId = await directConnection(options.agents, query);
            if (!connectionId) {const page = otherPage(query, contextOptionsBasis(query, destination, null)); report(operationId, stage, started, 0); return page;}
            stage = 'capabilities'; const inspection = await options.connections?.inspect(connectionId);
            if (!inspection) throw executionError('CONTEXT_OPTIONS_CONNECTION_UNAVAILABLE');
            stage = 'catalog'; const saved = await readContextCatalog(options.kernel, query.sessionId);
            const basis = contextOptionsBasis(query, destination, saved.version, inspection);
            stage = 'project'; const page = projectOptions(query, basis, saved.version, Object.values(saved.value.bindings), inspection);
            report(operationId, stage, started, page.sources.length); return page;
        } catch (error) {
            const code = safeCode(error, 'CONTEXT_OPTIONS_READ_FAILED');
            log.warn('Context options query', {operation: 'session.context.options', operationId, stage, result: 'failure',
                code, remoteCode: safeRemoteCode(error), durationMs: Date.now() - started});
            throw Object.assign(executionError(code), {remoteCode: safeRemoteCode(error)});
        }
    };
}
async function directConnection(agents: ContextOptionsReaderOptions['agents'], query: ContextOptionsQuery): Promise<string | undefined> {
    if (query.target.kind !== 'agent') return;
    const source = await agents.getAgentConfig(query.target.id), revision = await agents.getAgentRevision(query.target.id, query.target.version);
    if (!source || source.id !== query.target.id) throw executionError('CALL_TARGET_CHANGED');
    if (!revision) {
        if (await agents.getAgentRevision(query.target.id)) throw executionError('CALL_TARGET_CHANGED');
        assertRootCallable(source); return;
    }
    if (!sameTargetRef(revision.target, query.target)) throw executionError('CALL_TARGET_CHANGED');
    const definition = publishedAgentDefinition(revision); assertRootCallable(definition);
    if (definition.execution?.kind !== 'harness') return;
    if (typeof definition.execution.connectionId !== 'string' || !definition.execution.connectionId) throw executionError('CONTEXT_OPTIONS_CONNECTION_UNAVAILABLE');
    return definition.execution.connectionId;
}
function otherPage(query: ContextOptionsQuery, basis: string): ContextOptionsPage {
    assertBasis(query, basis);
    return {kind: 'other', target: query.target, sessionId: query.sessionId, branchId: query.branchId, basis, revision: null,
        dynamicPolicy: 'dispatch-validation-required', sources: [], modes: {new: {supported: false, code: 'CONTEXT_TARGET_UNSUPPORTED'},
            fork: {supported: false, code: 'CONTEXT_TARGET_UNSUPPORTED'}, continue: {supported: false, code: 'CONTEXT_TARGET_UNSUPPORTED'}}};
}
function projectOptions(query: ContextOptionsQuery, basis: string, revision: number | null, bindings: ContextBinding[],
    inspection: HarnessConnectionInspection): ContextOptionsPage {
    assertBasis(query, basis);
    const targetRef = directHarnessContextIdentity(query.target, inspection.snapshot.project).targetRef;
    const selected = query.bindingId ? bindings : bindings.filter(binding => binding.targetRef === targetRef);
    const page = bindingPage(query, revision, selected), byId = new Map(selected.map(binding => [binding.id, binding]));
    const sources = page.bindings.map(binding => ({...binding, fork: qualifyContextSource(byId.get(binding.ref.bindingId)!, query, inspection)}));
    const checkpoints = page.checkpoints?.map(checkpoint => ({...checkpoint, fork: qualifyContextCheckpoint(sources[0].fork,
        contextBindingCheckpoints(byId.get(sources[0].ref.bindingId)!).find(value => value.ref === checkpoint.ref)!)}));
    return {kind: 'direct-harness', target: query.target, sessionId: query.sessionId, branchId: query.branchId, basis, revision,
        dynamicPolicy: 'dispatch-validation-required', modes: {new: {supported: true},
            fork: {supported: checkpointForkSupported(inspection), ...(!checkpointForkSupported(inspection) ? {code: 'CONTEXT_CHECKPOINT_FORK_UNSUPPORTED'} : {})},
            continue: {supported: false, code: 'CONTEXT_NATIVE_WRITE_UNSUPPORTED'}}, sources,
        ...(checkpoints ? {checkpoints} : {}), ...(page.nextCursor ? {nextCursor: {basis, catalog: page.nextCursor}} : {})};
}
function bindingPage(query: ContextOptionsQuery, revision: number | null, bindings: ContextBinding[]): ContextBindingPage {
    if (query.checkpointRef) {
        const binding = bindings.find(item => item.id === query.bindingId);
        if (!binding) throw executionError('CONTEXT_BINDING_NOT_FOUND');
        const checkpoint = contextBindingCheckpoints(binding).find(item => item.ref === query.checkpointRef);
        if (!checkpoint) throw executionError('CONTEXT_CHECKPOINT_CHANGED');
        return {revision, bindings: [contextBindingSummary(binding)], checkpoints: [contextCheckpointSummary(checkpoint)]};
    }
    return projectContextBindingPage(revision, bindings, {sessionId: query.sessionId, bindingId: query.bindingId,
        limit: query.limit, ...(query.cursor ? {cursor: query.cursor.catalog} : {})});
}
function assertBasis(query: ContextOptionsQuery, basis: string): void {
    if (query.cursor && query.cursor.basis !== basis) throw executionError('CONTEXT_OPTIONS_CHANGED');
}
function safeCode(error: unknown, fallback: string): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : fallback;
}
function safeRemoteCode(error: unknown): string | undefined {return safeCode({code: (error as {remoteCode?: unknown})?.remoteCode}, '') || undefined;}
function report(operationId: string, stage: string, started: number, count: number): void {
    log.info('Context options query', {operation: 'session.context.options', operationId, stage, result: 'success', count, durationMs: Date.now() - started});
}
