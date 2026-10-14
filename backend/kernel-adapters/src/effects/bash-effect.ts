import type { LLMLogSink } from '@itookit/driver-llm/contracts';
import { silentAdapterLog } from '../ports/diagnostics';
import { assertEffectGrant } from '@itookit/durable-kernel';
import type { IToolService, ToolInvokeResult } from '@itookit/tools/contracts';
import type { EffectAdapter, EffectExecutionContext, EffectReconcileResult } from '@itookit/durable-kernel';
import { resolveCapability, type CapabilitySource } from '../ports/capabilities';
import { InFlightEffects } from './in-flight';
import { requireToolSuccess } from './tool-call-effect';

export interface BashEffectRequest {
    resourceHandleId: string;
    command: string;
    cwd?: string;
    timeoutMs?: number;
}

export class BashEffectAdapter implements EffectAdapter<BashEffectRequest, ToolInvokeResult> {
    readonly kind = 'process.exec';
    readonly version = '1';
    private readonly inFlight = new InFlightEffects();

    constructor(private readonly service: CapabilitySource<IToolService>, private readonly log: LLMLogSink = silentAdapterLog) {}

    async execute(request: BashEffectRequest, context: EffectExecutionContext): Promise<ToolInvokeResult> {
        return this.inFlight.track(context, this.run(request, context));
    }

    /** The Kernel aborts the signal first; waiting for the invoke confirms the process group stopped. */
    async cancel(_request: BashEffectRequest, context: EffectExecutionContext): Promise<void> {
        await this.inFlight.confirmStopped(context);
    }

    private async run(request: BashEffectRequest, context: EffectExecutionContext): Promise<ToolInvokeResult> {
        try { return await this.invoke(request, context); }
        catch (error) {
            this.log.error('[process.exec] Execution failed', { sessionId: context.sessionId, taskId: context.taskId,
                effectId: context.effectId, cwd: request.cwd, cancelled: context.abortSignal.aborted, error });
            throw error;
        }
    }

    private async invoke(request: BashEffectRequest, context: EffectExecutionContext): Promise<ToolInvokeResult> {
        assertEffectGrant(context, request.resourceHandleId, 'process');
        if (!request.command.trim()) throw new Error('Process command is required');
        const service = await resolveCapability(this.service, context);
        return requireToolSuccess(await service.invoke({
            toolId: 'Bash',
            args: { command: request.command, timeout_ms: request.timeoutMs },
            cwd: request.cwd,
            timeoutMs: request.timeoutMs,
            signal: context.abortSignal,
        }));
    }

    async reconcile(): Promise<EffectReconcileResult<ToolInvokeResult>> {
        return {
            status: 'indeterminate',
            error: { message: 'Bash process outcome cannot be reconciled after worker loss', code: 'PROCESS_INDETERMINATE' },
        };
    }
}
