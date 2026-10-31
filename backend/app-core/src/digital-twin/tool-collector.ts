import {submitPreparedTaskCall} from '@itookit/llm-flow';
import type {Kernel, TaskCallPlan, TaskCallResult} from '@itookit/durable-kernel';
import type {SessionRepository} from '@itookit/llm-session';
import type {TwinCollectionExecutor} from '@itookit/app-contracts';
import {validateCollectionTool, type CollectionToolCatalog} from './collection-tools';
import type {TwinCollectionRequest} from './scanner-collector';
import {TwinDiagnosticError} from './diagnostics';
import {collectionProgress} from './collection-progress';
export interface ToolCollectorOptions {
    kernel: Kernel; repository: SessionRepository; tools: CollectionToolCatalog;
    prepareSession(id: string): Promise<void>;
}
/** Direct calls use the existing Tool Program and tool.call Effect, without creating a Flow resource. */
export async function collectWithTool(options: ToolCollectorOptions, request: TwinCollectionRequest,
    attached: (id: string) => Promise<void>, bind: (id: string) => Promise<void>): Promise<import('@itookit/app-contracts').TwinCollectionProgress | undefined> {
    validateCollectionTool(options.tools, request.executor);
    const child = request.sessionId + '-tool';
    for (const id of [request.sessionId, child]) {
        await options.repository.ensureSession(id, 'Source collection'); await options.prepareSession(id);
    }
    await bind(child);
    const {kernel} = options, plan = collectionToolPlan(child, request.executor);
    const call = await submitPreparedTaskCall(plan, {kernel, caller: {sessionId: request.sessionId, requestId: 'collect-tool'}});
    try {await attached(call.root.id);} catch (error) {await call.root.cancel(undefined, {requestId: 'collection-cancel'}); throw error;}
    const exit = await call.root.wait({until: 'settled', timeoutMs: 180000}), result = exit.output as TaskCallResult | undefined;
    if (exit.status !== 'succeeded' || result?.exit.status !== 'succeeded') {
        const code = result?.exit.error?.code ?? exit.error?.code;
        throw new TwinDiagnosticError('TWIN_COLLECTION_FAILED', {message: code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'Tool collection did not succeed'});
    }
    return collectionProgress(result.exit.output);
}
export function collectionToolPlan(sessionId: string, executor: TwinCollectionExecutor): TaskCallPlan {
    if (executor.target.kind !== 'tool') throw new Error('TWIN_COLLECTION_TARGET_INVALID');
    return {targetSessionId: sessionId, maxDepth: 1, timeoutMs: 150000,
        task: {program: {kind: 'kernel-adapters.tool', version: '1'}, input: {
            toolId: executor.target.id, toolVersion: executor.target.version, args: executor.values ?? {},
            allowedToolIds: [executor.target.id], approval: 'none', timeoutMs: 120000,
        }}, bindings: [{kind: 'tool', uri: 'tool://session', rights: ['execute'], signalKey: 'toolHandleId'}]};
}
