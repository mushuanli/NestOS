import { assertEffectGrant } from '@itookit/durable-kernel';
import type { IToolService, ToolInvokeResult } from '@itookit/tools/contracts';
import type { EffectAdapter, EffectExecutionContext, EffectReconcileResult } from '@itookit/durable-kernel';
import { resolveCapability, type CapabilitySource } from '../ports/capabilities';
import { InFlightEffects } from './in-flight';
import { requireToolSuccess } from './tool-call-effect';

export type TtyEffectRequest =
    | { operation: 'spawn'; resourceHandleId: string; command: string; args?: string[]; cwd?: string; env?: Record<string, string>; idleTimeoutMs?: number }
    | { operation: 'write'; resourceHandleId: string; sessionId: string; data: string; idleTimeoutMs?: number }
    | { operation: 'close'; resourceHandleId: string; sessionId: string; signal?: string };

export class TtyEffectAdapter implements EffectAdapter<TtyEffectRequest, ToolInvokeResult> {
    readonly kind = 'tty.command';
    readonly version = '1';
    private readonly ownership = new Map<string, string>();
    private readonly inFlight = new InFlightEffects();

    constructor(private readonly service: CapabilitySource<IToolService>) {}

    async execute(request: TtyEffectRequest, context: EffectExecutionContext): Promise<ToolInvokeResult> {
        return this.inFlight.track(context, this.run(request, context));
    }

    /** The Kernel aborts the signal first; waiting for the invoke confirms the TTY call stopped. */
    async cancel(_request: TtyEffectRequest, context: EffectExecutionContext): Promise<void> {
        await this.inFlight.confirmStopped(context);
    }

    private async run(request: TtyEffectRequest, context: EffectExecutionContext): Promise<ToolInvokeResult> {
        assertTtyGrant(request.resourceHandleId, context);
        this.assertOwnership(request, context);
        const service = await resolveCapability(this.service, context);
        const result = requireToolSuccess(await service.invoke({
            toolId: ttyToolId(request),
            args: ttyToolArgs(request),
            cwd: request.operation === 'spawn' ? request.cwd : undefined,
            signal: context.abortSignal,
        }));
        this.updateOwnership(request, context, result);
        return result;
    }

    async reconcile(): Promise<EffectReconcileResult<ToolInvokeResult>> {
        return {
            status: 'indeterminate',
            error: { message: 'TTY session cannot be reattached after worker loss', code: 'TTY_INDETERMINATE' },
        };
    }

    private assertOwnership(request: TtyEffectRequest, context: EffectExecutionContext): void {
        if (request.operation === 'spawn') return;
        const expected = this.ownership.get(ownershipKey(context.sessionId, request.resourceHandleId));
        if (!expected || expected !== request.sessionId) {
            throw new Error(`TTY session is not owned by resource handle: ${request.resourceHandleId}`);
        }
    }

    private updateOwnership(
        request: TtyEffectRequest,
        context: EffectExecutionContext,
        result: ToolInvokeResult,
    ): void {
        const key = ownershipKey(context.sessionId, request.resourceHandleId);
        if (request.operation === 'close') {
            this.ownership.delete(key);
            return;
        }
        if (request.operation !== 'spawn') return;
        const sessionId = /^\[TTY Session: ([^\]]+)\]/m.exec(result.output)?.[1];
        if (!sessionId) throw new Error('TTY spawn result did not include a session identifier');
        this.ownership.set(key, sessionId);
    }
}

function assertTtyGrant(handleId: string, context: EffectExecutionContext): void {
    assertEffectGrant(context, handleId, 'tty');
}

function ownershipKey(sessionId: string, handleId: string): string {
    return `${sessionId}/${handleId}`;
}

function ttyToolId(request: TtyEffectRequest): string {
    if (request.operation === 'spawn') return 'shell_session';
    if (request.operation === 'write') return 'tty_write';
    return 'tty_close';
}

function ttyToolArgs(request: TtyEffectRequest): Record<string, unknown> {
    if (request.operation === 'spawn') return {
        command: request.command, args: request.args, cwd: request.cwd,
        env: request.env, idle_timeout_ms: request.idleTimeoutMs,
    };
    if (request.operation === 'write') return {
        session_id: request.sessionId, data: request.data, idle_timeout_ms: request.idleTimeoutMs,
    };
    return { session_id: request.sessionId, signal: request.signal };
}
