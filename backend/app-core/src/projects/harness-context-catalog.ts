import {createModuleLogger, randomUUID, sha256HexSync} from '@itookit/common';
import {KernelError, KernelErrorCode, type Kernel, type JsonValue} from '@itookit/durable-kernel';
import type {ContextBinding, ContextCheckpoint} from '@itookit/kernel-adapters/contracts';
import {assertContextBindingQuery, type ContextBindingPage, type ContextBindingQuery, type ContextBindingReader,
    type ContextBindingSummary, type ContextCheckpointSummary} from '@itookit/llm-session/contracts';
import {readContextBindingCollection} from './harness-context-bindings';
import {executionError} from './harness-execution-journal';

const log = createModuleLogger('ContextBindings');
type ContextInspection = Pick<Awaited<ReturnType<Kernel['inspectSession']>>, 'getShared'>;
export interface ContextInspector {inspectSession(sessionId: string): Promise<ContextInspection>}

export function createContextBindingReader(kernel: ContextInspector): ContextBindingReader {
    return async supplied => {
        const started = Date.now(), operationId = randomUUID(); let stage = 'validate';
        try {
            assertContextBindingQuery(supplied); const query = structuredClone(supplied); stage = 'read';
            const saved = await readContextCatalog(kernel, query.sessionId);
            stage = 'project'; const page = projectContextBindingPage(saved.version, Object.values(saved.value.bindings), query);
            log.info('Context binding query', {operation: 'session.context.bindings', operationId, stage, result: 'success',
                count: page.checkpoints?.length ?? page.bindings.length, durationMs: Date.now() - started});
            return page;
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            log.warn('Context binding query', {operation: 'session.context.bindings', operationId, stage, result: 'failure',
                remoteCode: safeRemoteCode(error),
                code: typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code) ? code : 'CONTEXT_QUERY_FAILED', durationMs: Date.now() - started});
            throw error;
        }
    };
}
export function readContextCatalog(kernel: ContextInspector, sessionId: string): Promise<{
    version: number | null; value: {version: 1; sessionId: string; bindings: Record<string, ContextBinding>};
}> {
    return readContextBindingCollection({get: <T extends JsonValue>(key: string) => readShared<T>(kernel, sessionId, key)}, sessionId);
}

function safeRemoteCode(error: unknown): string | undefined {
    const code = (error as {remoteCode?: unknown})?.remoteCode;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : undefined;
}

async function readShared<T extends JsonValue>(kernel: ContextInspector, sessionId: string, key: string) {
    // Ordinary Kernel.getShared remembers the binding and starts resource observation.
    try {return await (await kernel.inspectSession(sessionId)).getShared<T>(key);}
    catch (error) {if (error instanceof KernelError && error.code === KernelErrorCode.SESSION_NOT_FOUND) return undefined; throw error;}
}

export function projectContextBindingPage(revision: number | null, bindings: ContextBinding[], query: ContextBindingQuery): ContextBindingPage {
    if (query.cursor && query.cursor.revision !== revision) throw executionError('CONTEXT_CATALOG_CHANGED');
    if (query.cursor && query.cursor.scope !== queryScope(query)) throw executionError('CONTEXT_CURSOR_INVALID');
    const selected = bindings.filter(binding => query.branchId === undefined || binding.branchId === query.branchId);
    if (!query.bindingId) {
        const rows = selected.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const page = slice(rows, binding => binding.id, query, revision);
        return {revision, bindings: page.rows.map(contextBindingSummary), ...(page.nextCursor ? {nextCursor: page.nextCursor} : {})};
    }
    const binding = selected.find(binding => binding.id === query.bindingId);
    if (!binding) throw executionError('CONTEXT_BINDING_NOT_FOUND');
    const page = slice(contextBindingCheckpoints(binding), checkpoint => checkpoint.ref, query, revision);
    return {revision, bindings: [contextBindingSummary(binding)], checkpoints: page.rows.map(contextCheckpointSummary),
        ...(page.nextCursor ? {nextCursor: page.nextCursor} : {})};
}

export function contextCheckpointSummary(checkpoint: ContextCheckpoint): ContextCheckpointSummary {
    const base = {ref: checkpoint.ref, ...(checkpoint.previousRef ? {previousRef: checkpoint.previousRef} : {})};
    return checkpoint.kind === 'terminal' ? {...base, kind: checkpoint.kind, invocationId: checkpoint.operation.invocationId}
        : {...base, kind: checkpoint.kind};
}
export function contextBindingCheckpoints(binding: ContextBinding): ContextCheckpoint[] {
    return binding.checkpoints ?? (binding.knownHeadRef ? [{kind: 'legacy-head', ref: binding.knownHeadRef}] : []);
}

function slice<T>(rows: T[], id: (row: T) => string, query: ContextBindingQuery, revision: number | null) {
    const index = query.cursor ? rows.findIndex(row => id(row) === query.cursor!.after) : -1;
    if (query.cursor && index < 0) throw executionError('CONTEXT_CURSOR_INVALID');
    const result = rows.slice(index + 1, index + 1 + (query.limit ?? 25));
    const nextCursor = revision !== null && result.length && index + 1 + result.length < rows.length
        ? {revision, after: id(result.at(-1)!), scope: queryScope(query)} : undefined;
    return {rows: result, nextCursor};
}

function queryScope(query: ContextBindingQuery): string {return sha256HexSync(JSON.stringify([query.sessionId, query.branchId ?? null, query.bindingId ?? null]));}

export function contextBindingSummary(binding: ContextBinding): ContextBindingSummary {
    return {ref: {bindingId: binding.id, revision: binding.revision, generation: binding.generation}, branchId: binding.branchId,
        targetRef: binding.targetRef, connectionId: binding.connectionId, validity: binding.validity,
        ...(binding.invalidReason ? {invalidReason: binding.invalidReason} : {}), busy: !!binding.activeOperation,
        ...(binding.knownHeadRef ? {knownHeadRef: binding.knownHeadRef} : {}), checkpointCount: contextBindingCheckpoints(binding).length};
}
