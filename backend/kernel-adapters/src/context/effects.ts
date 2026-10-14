import type { ContextPrepareInput, ContextCursor, IContextService, PreparedContext } from '@itookit/llm-context';
import { CONTEXT_TOOL_IDS, invokeContextTool, ContextError } from '@itookit/llm-context';
import { assertEffectGrant, type EffectAdapter, type EffectExecutionContext } from '@itookit/durable-kernel';
import type { ChatCompletionResponse } from '@itookit/driver-llm/contracts';
import type { ToolInvokeResult } from '@itookit/tools/contracts';
import type { LlmChatEffectRequest } from '../effects/llm-chat-effect';
import type { ToolCallEffectRequest } from '../effects/tool-call-effect';
import { InFlightEffects } from '../effects/in-flight';

export type ContextServiceResolver = (context: EffectExecutionContext, prepare?: PrepareContextRequest) => Promise<IContextService>;
export interface PrepareContextRequest extends Omit<ContextPrepareInput, 'contextId' | 'operationId'> {
    resourceHandleId: string;
    connectionId: string;
}

export class ContextPrepareEffect implements EffectAdapter<PrepareContextRequest, PreparedContext> {
    readonly kind = 'context.prepare';
    readonly version = '1';
    readonly recoveryPolicy = 'idempotent-retry' as const;
    private readonly inFlight = new InFlightEffects();
    constructor(private readonly resolve: ContextServiceResolver) {}
    execute(request: PrepareContextRequest, context: EffectExecutionContext) {
        return this.inFlight.track(context, this.run(request, context));
    }
    private async run(request: PrepareContextRequest, context: EffectExecutionContext) {
        assertEffectGrant(context, request.resourceHandleId, 'llm');
        context.abortSignal.throwIfAborted();
        const service = await this.resolve(context, request);
        const result = await service.prepare({ ...request, contextId: context.taskId, operationId: context.effectId });
        context.abortSignal.throwIfAborted();
        return result;
    }
    async cancel(_request: PrepareContextRequest, context: EffectExecutionContext) { await this.inFlight.confirmStopped(context); }
    async reconcile() { return { status: 'retry' as const }; }
}

interface SnapshotRequest { cursor: ContextCursor; resourceHandleId: string; connectionId: string }
export class ContextLlmEffect implements EffectAdapter<SnapshotRequest, ChatCompletionResponse> {
    readonly kind = 'llm.chat';
    readonly version = '2';
    private readonly inFlight = new InFlightEffects();
    constructor(private readonly resolve: ContextServiceResolver, private readonly llm: EffectAdapter<LlmChatEffectRequest, ChatCompletionResponse>) {}
    execute(request: SnapshotRequest, context: EffectExecutionContext) {
        return this.inFlight.track(context, this.run(request, context));
    }
    private async run(request: SnapshotRequest, context: EffectExecutionContext) {
        assertEffectGrant(context, request.resourceHandleId, 'llm');
        if (request.cursor.contextId !== context.taskId) throw new Error('Context owner mismatch');
        const snapshot = await (await this.resolve(context)).request(request.cursor);
        context.abortSignal.throwIfAborted();
        return this.llm.execute({ resourceHandleId: request.resourceHandleId, connectionId: request.connectionId,
            request: snapshot.request as unknown as LlmChatEffectRequest['request'] }, context);
    }
    async cancel(_request: SnapshotRequest, context: EffectExecutionContext) {
        await this.llm.cancel?.({} as LlmChatEffectRequest, context);
        await this.inFlight.confirmStopped(context);
    }
    shouldRetry(error: unknown, context: EffectExecutionContext) { return this.llm.shouldRetry?.(error, context) ?? false; }
    async reconcile() { return { status: 'indeterminate' as const, error: { code: 'LLM_INDETERMINATE', message: 'LLM outcome is unknown' } }; }
}

interface ContextToolRequest extends ToolCallEffectRequest { maxOutputBytes?: number }
interface OutputAdmittingToolEffect extends EffectAdapter<ToolCallEffectRequest, ToolInvokeResult> {
    executeWithOutputAdmission?: (request: ToolCallEffectRequest, context: EffectExecutionContext,
        admit: import('@itookit/tools/contracts').ToolInvokeRequest['admitOutput']) => Promise<ToolInvokeResult>;
}
export class ContextToolEffect implements EffectAdapter<ContextToolRequest, ToolInvokeResult> {
    readonly kind = 'tool.call';
    readonly version = '2';
    private readonly inFlight = new InFlightEffects();
    constructor(private readonly resolve: ContextServiceResolver, private readonly tool: OutputAdmittingToolEffect) {}
    execute(request: ContextToolRequest, context: EffectExecutionContext) {
        return this.inFlight.track(context, this.run(request, context));
    }
    private async run(request: ContextToolRequest, context: EffectExecutionContext) {
        assertEffectGrant(context, request.resourceHandleId, 'tool');
        if ((CONTEXT_TOOL_IDS as readonly string[]).includes(request.toolId)) {
            return this.runContextTool(request, context);
        }
        const service = await this.resolve(context);
        const admit = (output: string) => service.admitOutput(output, request.maxOutputBytes);
        const result = this.tool.executeWithOutputAdmission
            ? await this.tool.executeWithOutputAdmission(request, context, admit) : await this.tool.execute(request, context);
        const bounded = await admit(result.output);
        context.abortSignal.throwIfAborted();
        return { ...result, ...bounded };
    }
    private async runContextTool(request: ContextToolRequest, context: EffectExecutionContext): Promise<ToolInvokeResult> {
        const service = await this.resolve(context);
        try {
            const result = await invokeContextTool(service, context.taskId, request.toolId, request.args);
            const bounded = await service.admitOutput(result.output, request.maxOutputBytes);
            context.abortSignal.throwIfAborted();
            return { toolId: request.toolId, success: true, durationMs: 0, ...result, ...bounded };
        } catch (error) {
            if (!(error instanceof ContextError) || !['CONTEXT_INVALID_LIMIT', 'CONTEXT_CHECKPOINT_REQUIRED'].includes(error.code)) throw error;
            return { toolId: request.toolId, success: false, durationMs: 0, recoverable: true, output: error.message, errorCode: error.code };
        }
    }
    async cancel(request: ToolCallEffectRequest, context: EffectExecutionContext) {
        await this.tool.cancel?.(request, context);
        await this.inFlight.confirmStopped(context);
    }
    async reconcile(request: ToolCallEffectRequest, context: EffectExecutionContext) {
        if ((CONTEXT_TOOL_IDS as readonly string[]).includes(request.toolId)) return { status: 'retry' as const };
        return await this.tool.reconcile?.(request, context) ?? { status: 'indeterminate' as const, error: { message: 'Tool outcome unknown' } };
    }
}
