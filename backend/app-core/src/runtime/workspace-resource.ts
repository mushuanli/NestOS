import {createModuleLogger} from '@itookit/common';
import {waitForFlowRunTasks, type FlowWorkspaceLease, type FlowWorkspaceManager} from '@itookit/llm-flow';
import type {FlowWorkspacePolicy} from '@itookit/llm-flow/contracts';
import type {JsonValue, Kernel, ResourceClaim, ResourceCleanupContext, ResourceCleanupReceipt} from '@itookit/durable-kernel';
import type {HeadlessKernelRuntime} from './create-kernel-runtime';

const kind = 'mindos.flow-workspace', log = createModuleLogger('flow-workspace');
interface Owner {sessionId: string; taskId: string}
interface Options {runtime: HeadlessKernelRuntime; manager: FlowWorkspaceManager; canWrite?(sessionId: string): Promise<boolean>}

/** Physical cleanup is reconstructed from the original root, never from a replacement directory. */
export function registerWorkspaceResource(options: Options): void {
    const cleanup = (context: ResourceCleanupContext) => finalize(context, options);
    options.runtime.kernel.registerResourceAdapter({kind, version: '1', timeoutMs: 60_000, cleanup, destroy: cleanup});
}

export function managedWorkspaceLease(sessionId: string, lease: FlowWorkspaceLease,
    kernel: Kernel): FlowWorkspaceLease {
    let owner: Owner | undefined, claim: ResourceClaim | undefined;
    return {...lease,
        attach: async taskId => {
            const started = Date.now(); owner = {sessionId, taskId};
            try {
                const task = await kernel.attachTask(sessionId, taskId), resource = await (await task.resources.create({
                    requestId: `flow-workspace:${taskId}`, kind: 'pool', name: 'flow-workspace', capacity: 1,
                    physical: {kind, version: '1', externalId: JSON.stringify(owner)}})).wait();
                const handle = await (await task.resources.open(resource.ref, {requestId: `flow-workspace:${taskId}:open`,
                    name: 'flow-workspace', rights: ['execute']})).wait();
                claim = await (await task.resources.acquire(handle, {requestId: `flow-workspace:${taskId}:acquire`, quantity: 1})).wait();
                diagnose('attach', owner, started);
            } catch (error) {diagnose('attach', owner, started, error); throw error;}
        },
        releaseCapabilities: async taskId => {if (!claim) await lease.releaseCapabilities?.(taskId);},
        finish: async status => {
            if (!owner || !claim) return lease.finish(status);
            const task = await kernel.attachTask(owner.sessionId, owner.taskId);
            await (await task.resources.release(claim, {requestId: `flow-workspace:${owner.taskId}:release`})).wait();
            const saved = await (await kernel.inspectSession(owner.sessionId)).getShared(resultKey(owner.taskId));
            const message = (saved?.value as {message?: unknown} | undefined)?.message;
            return typeof message === 'string' ? {message} : undefined;
        }};
}

async function finalize(context: ResourceCleanupContext, options: Options): Promise<ResourceCleanupReceipt> {
    const owner = parseOwner(context), started = Date.now(); let stage = 'permission';
    try {
        if (options.canWrite && !await options.canWrite(owner.sessionId)) throw failure('FLOW_WORKSPACE_READ_ONLY');
        context.signal.throwIfAborted();
        const session = await options.runtime.kernel.openSession(owner.sessionId);
        const root = (await (await session.attachTask(owner.taskId)).status()).task;
        if (root.program.kind !== 'flow.aggregate' || root.labels?.kind !== 'flow-root') throw failure('FLOW_WORKSPACE_OWNER_INVALID');
        if (!root.exit) return {operationId: context.operationId, epoch: context.epoch, status: 'pending', retryAfterMs: 500};
        stage = 'receipt';
        if (await session.getShared(resultKey(owner.taskId))) return stopped(context);
        const input = root.input as {initialScheduler?: {spec?: {runPolicy?: {workspace?: FlowWorkspacePolicy}}}; initialWorkspace?: JsonValue};
        const policy = input.initialScheduler?.spec?.runPolicy?.workspace, record = input.initialWorkspace;
        if (!policy || policy.mode === 'shared' || record === undefined || !options.manager.restore) throw failure('FLOW_WORKSPACE_RECORD_MISSING');
        stage = 'members'; await waitForFlowRunTasks(session, owner.taskId, context.signal);
        stage = 'capabilities'; await options.runtime.disposeScope(owner.sessionId, owner.taskId);
        context.signal.throwIfAborted(); stage = 'restore';
        const lease = await options.manager.restore(owner.sessionId, policy, record, {forFinalization: true});
        await lease.releaseCapabilities?.(owner.taskId);
        context.signal.throwIfAborted(); stage = 'physical-finish'; const result = await lease.finish(root.exit.status);
        stage = 'persist'; await session.setShared(resultKey(owner.taskId), {version: 1, ...(result?.message ? {message: result.message} : {})});
        diagnose(stage, owner, started); return stopped(context);
    } catch (error) {diagnose(stage, owner, started, error); throw error;}
}
function parseOwner(context: ResourceCleanupContext): Owner {
    let owner: Owner;
    try {owner = JSON.parse(context.physical.externalId) as Owner;}
    catch {throw failure('FLOW_WORKSPACE_OWNER_INVALID');}
    if (!owner || ![owner.sessionId, owner.taskId].every(id => typeof id === 'string' && /^[\w:-]{1,256}$/.test(id))
        || context.claim && (context.claim.sessionId !== owner.sessionId || context.claim.taskId !== owner.taskId))
        throw failure('FLOW_WORKSPACE_OWNER_INVALID');
    return owner;
}
function stopped(context: ResourceCleanupContext): ResourceCleanupReceipt {
    return {operationId: context.operationId, epoch: context.epoch, status: 'stopped'};
}
function resultKey(taskId: string): string {return `flow.run.${taskId}.workspace-resource-result`;}
function failure(code: string): Error {return Object.assign(new Error(code), {code});}
function diagnose(stage: string, owner: Owner, started: number, error?: unknown): void {
    const code = (error as {code?: unknown})?.code;
    const detail = {operation: 'flow.workspace.resource', operationId: `flow-workspace:${owner.taskId}`, ...owner, stage,
        outcome: error ? 'failure' : 'success', durationMs: Date.now() - started,
        errorCode: error ? typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'FLOW_WORKSPACE_RESOURCE_FAILED' : undefined};
    try {if (error) log.warn('Flow workspace resource', detail); else log.info('Flow workspace resource', detail);}
    catch { /* Logging never changes ownership or physical cleanup receipts. */ }
}
