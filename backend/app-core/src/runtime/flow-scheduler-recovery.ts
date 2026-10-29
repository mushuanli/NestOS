import {createModuleLogger} from '@itookit/common';
import type {KernelViewPort, TaskRecord} from '@itookit/durable-kernel/contracts';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import type {ICommandBus} from '@itookit/llm-session/contracts';

const log = createModuleLogger('flow-scheduler-recovery');
/** Reattach admitted Flow schedulers, including reruns which have no invocation journal. */
export async function recoverFlowSchedulers(kernel: KernelViewPort, commands: ICommandBus,
    writable: (sessionId: string) => Promise<boolean>): Promise<() => void> {
    const disposers: (() => void)[] = [];
    for await (const session of kernel.listSessions()) {
        if (session.status !== 'open') continue;
        const started = Date.now();
        try {
            const roots = (await kernel.listSessionTasks(session.id)).filter(needsScheduler);
            if (!roots.length) continue;
            for (const root of roots) disposers.push(await recoverRoot(session.id, root.id, commands, writable));
        } catch (error) {report(session.id, session.id, 'scan', started, error);}
    }
    return () => disposers.forEach(dispose => dispose());
}
function needsScheduler(task: TaskRecord): boolean {
    if (task.program.kind !== 'flow.aggregate' || task.labels?.kind !== 'flow-root'
        || ['succeeded', 'failed', 'cancelled'].includes(task.status)) return false;
    const state = task.state ?? task.input;
    return !!state && typeof state === 'object' && !Array.isArray(state) && 'awaitingSchedule' in state && state.awaitingSchedule === true;
}
async function recoverRoot(sessionId: string, taskId: string, commands: ICommandBus,
    writable: (sessionId: string) => Promise<boolean>): Promise<() => void> {
    let closed = false, attempts = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {if (!closed) timer = setTimeout(() => {void attempt();}, Math.min(30_000, 1000 * 2 ** attempts++));};
    const attempt = async () => {
        const started = Date.now();
        try {
            if (closed) return;
            if (!await writable(sessionId)) {schedule(); return;}
            if (closed) return;
            await commands.execute(FlowCommand.RunResume, {sessionId, taskId});
            report(sessionId, taskId, 'reattach', started);
        } catch (error) {
            if (closed) return;
            report(sessionId, taskId, 'reattach', started, error);
            if ((error as {code?: string})?.code === 'FLOW_SCHEDULER_BUSY')
                schedule();
        }
    };
    await attempt();
    return () => {closed = true; clearTimeout(timer);};
}
function report(sessionId: string, operationId: string, stage: string, started: number, error?: unknown): void {
    const code = (error as {code?: unknown})?.code;
    const detail = {operation: 'flow.scheduler.recover', sessionId, operationId, stage,
        result: error ? 'deferred' : 'attached', code: error ? typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'FLOW_SCHEDULER_RECOVERY_FAILED' : undefined,
        durationMs: Date.now() - started};
    if (error) log.warn('flow.scheduler.recover', detail); else log.info('flow.scheduler.recover', detail);
}
