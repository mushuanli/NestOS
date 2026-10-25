import type { SessionHandle, TaskHandle, TaskSpec } from '@itookit/durable-kernel';
import {assertLiveFlowRoot, flowTaskHeld, isPausedParentAdmission} from './control-tree';

interface DispatchGateOptions {
    session: SessionHandle;
    root: TaskHandle;
    isDisposed(): boolean;
    assertOwned(): Promise<void>;
}

/** Recovery reuses the generation; a graph retry advances it before resubmission. */
export function flowNodeRequestId(rootId: string, nodeId: string, iteration: number, generation = 0): string {
    return `flow:${rootId}:${nodeId}#${iteration}@${generation}`;
}

/** Wait on existing durable control facts; Task admission remains the atomic execution fence. */
export class FlowDispatchGate {
    constructor(private readonly options: DispatchGateOptions) {}

    async wait(): Promise<boolean> {
        const startedAt = Date.now();
        let held = false;
        while (!this.options.isDisposed()) {
            await this.options.assertOwned();
            const root = (await this.options.root.status()).task;
            assertLiveFlowRoot(root);
            if (!flowTaskHeld(root)) {
                if (held) this.report('released', startedAt);
                return true;
            }
            if (!held) this.report('paused', startedAt);
            held = true;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        return false;
    }

    async submit(spec: TaskSpec): Promise<TaskHandle | undefined> {
        while (await this.wait()) {
            try { return await this.options.session.submit(spec); }
            catch (error) {
                if (!isPausedParentAdmission(error) || spec.parent !== this.options.root.id) throw error;
                assertLiveFlowRoot((await this.options.root.status()).task);
                this.report('admission-paused', Date.now(), spec.requestId);
            }
        }
        return undefined;
    }

    private report(stage: string, startedAt: number, operationId?: string): void {
        const safe = operationId && /^[\w:,.@#-]{1,256}$/.test(operationId) ? operationId : undefined;
        try { console.debug('flow.node.submit', {operation: 'flow.node.submit', stage, outcome: stage === 'released' ? 'success' : 'blocked',
            code: 'FLOW_DISPATCH_PAUSED', sessionId: this.options.session.id, rootTaskId: this.options.root.id,
            operationId: safe, durationMs: Date.now() - startedAt});
        } catch { /* Diagnostics must not change dispatch admission. */ }
    }
}
