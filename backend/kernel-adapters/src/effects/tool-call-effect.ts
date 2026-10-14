import type { LLMLogSink } from '@itookit/driver-llm/contracts';
import { silentAdapterLog } from '../ports/diagnostics';
import { assertEffectGrant } from '@itookit/durable-kernel';
import type { ISkillService } from '@itookit/tools/contracts';
import type { IToolService, ToolInvokeResult } from '@itookit/tools/contracts';
import type { EffectAdapter, EffectExecutionContext, EffectReconcileResult } from '@itookit/durable-kernel';
import { forgetLoadedSkill, rollbackFailedLoad } from '../skill/loaded-state';
import { InFlightEffects } from './in-flight';

type ToolSource = IToolService | ((context: EffectExecutionContext, request: ToolCallEffectRequest) => IToolService | Promise<IToolService>);
/** Live Skill state used to undo a load whose identity write failed. */
export type SkillLoadTracker = Pick<ISkillService, 'getLoadedSkills' | 'unloadSkill'>;

/** Host tools requiring Kernel-owned execution identity rather than model arguments. */
export interface EffectToolBinding {
    meta: import('@itookit/tools/contracts').ToolMeta;
    definition: import('@itookit/tools/contracts').ToolDefinition;
    invoke(args: Record<string, unknown>, context: EffectExecutionContext): Promise<string>;
}

export interface ToolCallEffectRequest {
    callId?: string;
    resourceHandleId: string;
    toolId: string;
    args: Record<string, unknown>;
    cwd?: string;
    timeoutMs?: number;
}

export class ToolCallEffectAdapter implements EffectAdapter<ToolCallEffectRequest, ToolInvokeResult> {
    readonly kind = 'tool.call';
    readonly version = '1';
    private readonly inFlight = new InFlightEffects();

    constructor(
        private readonly service: ToolSource,
        private readonly onSkillLoaded?: (skillId: string, context: EffectExecutionContext) => void | ToolInvokeResult['skillContext'] | Promise<void | ToolInvokeResult['skillContext']>,
        private readonly resolveSkillTracker?: (context: EffectExecutionContext) => Promise<SkillLoadTracker | undefined>,
        private readonly effectTools: EffectToolBinding[] = [],
        private readonly log: LLMLogSink = silentAdapterLog,
    ) {}

    async execute(request: ToolCallEffectRequest, context: EffectExecutionContext): Promise<ToolInvokeResult> {
        return this.inFlight.track(context, this.run(request, context));
    }

    executeWithOutputAdmission(request: ToolCallEffectRequest, context: EffectExecutionContext,
        admit: import('@itookit/tools/contracts').ToolInvokeRequest['admitOutput']): Promise<ToolInvokeResult> {
        return this.inFlight.track(context, this.run(request, context, admit));
    }

    /** The Kernel aborts the signal first; waiting for the invoke confirms the tool stopped. */
    async cancel(_request: ToolCallEffectRequest, context: EffectExecutionContext): Promise<void> {
        await this.inFlight.confirmStopped(context);
    }

    private async run(request: ToolCallEffectRequest, context: EffectExecutionContext,
        admitOutput?: import('@itookit/tools/contracts').ToolInvokeRequest['admitOutput']): Promise<ToolInvokeResult> {
        try { return await this.invoke(request, context, admitOutput); }
        catch (error) {
            this.log.error('[tool.call] Execution failed', { sessionId: context.sessionId, taskId: context.taskId,
                effectId: context.effectId, toolId: request.toolId, cwd: request.cwd,
                cancelled: context.abortSignal.aborted, error });
            throw error;
        }
    }

    private async invoke(request: ToolCallEffectRequest, context: EffectExecutionContext,
        admitOutput?: import('@itookit/tools/contracts').ToolInvokeRequest['admitOutput']): Promise<ToolInvokeResult> {
        assertEffectGrant(context, request.resourceHandleId, 'tool');
        const service = await (typeof this.service === 'function' ? this.service(context, request) : this.service);
        const bound = this.effectTools.find(tool => tool.meta.id === request.toolId);
        if (bound) {
            if (service.getToolMeta(request.toolId)?.enabled !== true) throw new Error('Effect tool is disabled');
            context.abortSignal.throwIfAborted();
            const started = Date.now();
            const output = await bound.invoke(request.args, context);
            return { toolId: request.toolId, success: true, output, durationMs: Date.now() - started };
        }
        const unloadKey = service.getToolMeta(request.toolId)?.skillUnloaderArgKey;
        if (unloadKey) {
            const id = request.args[unloadKey];
            if (typeof id !== 'string' || !id.trim()) throw new Error('skill_id argument is required');
            if (service.getToolMeta(request.toolId)?.enabled !== true) throw new Error('Skill unload tool is disabled');
            await forgetLoadedSkill(id, context.sessionState);
        }
        const key = service.getToolMeta(request.toolId)?.skillLoaderArgKey;
        const skillId = key ? request.args[key] : undefined;
        const loadsSkill = typeof skillId === 'string' && Boolean(skillId);
        // Capture the live state before the tool runs: only a load this call
        // introduced may be undone when identity persistence fails.
        const tracker = loadsSkill ? await this.resolveSkillTracker?.(context) : undefined;
        const wasLoaded = tracker ? tracker.getLoadedSkills().some(item => item.id === skillId) : true;
        const onProgress: import('@itookit/tools/contracts').ToolInvokeRequest['onProgress'] = request.callId ? async progress => {
            context.abortSignal.throwIfAborted();
            await context.emit?.({ type: 'agent.event', payload: { type: 'tool:progress', call: {
                toolId: request.callId!, name: request.toolId, input: request.args,
                progress: { message: progress.message.slice(0, 2048), output: progress.output?.slice(0, 8192) },
            } } });
        } : undefined;
        const result = await service.invoke({ ...request, signal: context.abortSignal, admitOutput, onProgress });
        // Unload has already changed persistent state; its cleanup must still settle as an Effect.
        if (result.recoverable !== true || unloadKey) requireToolSuccess(result);
        let skillContext: ToolInvokeResult['skillContext'];
        if (loadsSkill && result.success) {
            try {
                const loaded = await this.onSkillLoaded?.(skillId as string, context);
                skillContext = loaded ? loaded : undefined;
            } catch (error) {
                if (tracker && !wasLoaded) await rollbackFailedLoad(tracker, skillId as string, error);
                throw error;
            }
        }
        // Tool/provider output cannot manufacture persistent policy context.
        const { skillContext: _untrusted, ...output } = result;
        return skillContext ? { ...output, skillContext } : output;
    }

    async reconcile(
        request: ToolCallEffectRequest,
        context: EffectExecutionContext,
    ): Promise<EffectReconcileResult<ToolInvokeResult>> {
        const service = await (typeof this.service === 'function' ? this.service(context, request) : this.service);
        if (service.getToolMeta(request.toolId)?.sideEffect === 'none') return { status: 'retry' };
        return {
            status: 'indeterminate',
            error: { message: `Tool outcome cannot be reconciled: ${request.toolId}`, code: 'TOOL_INDETERMINATE' },
        };
    }
}

export function requireToolSuccess(result: ToolInvokeResult): ToolInvokeResult {
    if (result.success) return result;
    throw new Error(result.error ?? result.output ?? `Tool failed: ${result.toolId}`);
}
