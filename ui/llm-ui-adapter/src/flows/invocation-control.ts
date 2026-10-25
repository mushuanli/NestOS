import type {TaskRecord} from '@itookit/durable-kernel/contracts';
import {hasFlowControlTree, type DurableFlowSnapshot} from '@itookit/llm-flow/contracts';

export interface InvocationControl {
    terminal: boolean;
    state: 'active' | 'pausing' | 'paused' | 'constrained' | 'terminal';
    externalHold: boolean;
    supportsPause: boolean;
    canRelease: boolean;
    canWithdraw: boolean;
    canReattach: boolean;
    actionsKey: string;
}

/** A pause request grants no stopped guarantee while a managed operation remains in flight. */
export function invocationControl(snapshot: DurableFlowSnapshot): InvocationControl {
    const root = snapshot.root.task, frame = controlledFrame(snapshot), terminal = isTerminal(root.status), supportsPause = hasFlowControlTree(root);
    const requested = root.control?.mode === 'pause';
    const externalHold = frame.tasks.some(task => task.sessionPaused || task.controlHolds?.some(id => !frame.ids.has(id)));
    const stopped = frame.complete && frame.tasks.every(task => snapshot.controlStats?.[task.id]?.stopped === true);
    const canRelease = !terminal && root.control?.mode === 'pause' && root.control.acknowledged === true && stopped
        && Number.isSafeInteger(root.control.epoch) && root.control.epoch >= 0;
    const state = controlState(terminal, requested, canRelease, externalHold);
    return {terminal, state, externalHold, supportsPause, canRelease, canWithdraw: supportsPause && canWithdrawPause(root, frame),
        canReattach: !!snapshot.attachedFromStorage && state === 'active',
        actionsKey: JSON.stringify([root.status, snapshot.attachedFromStorage, supportsPause, frame.complete,
            frame.tasks.map(task => controlIdentity(task, snapshot.controlStats?.[task.id]?.stopped)), [...frame.ids]])};
}

export function invocationStatus(snapshot: DurableFlowSnapshot, control = invocationControl(snapshot)): string {
    if (control.terminal) return snapshot.root.task.status;
    if (control.state !== 'active') return control.state;
    const requests = invocationControlTasks(snapshot).filter(task => !isTerminal(task.status)).flatMap(task => Object.values(task.interactions ?? {})).filter(request => request.status === 'pending');
    if (requests.some(request => request.kind === 'approval')) return 'waitingApproval';
    return requests.length ? 'waitingInput' : snapshot.root.task.status;
}

function controlState(terminal: boolean, requested: boolean, confirmed: boolean, external: boolean): InvocationControl['state'] {
    if (terminal) return 'terminal';
    if (requested) return confirmed ? 'paused' : 'pausing';
    return external ? 'constrained' : 'active';
}

function canWithdrawPause(root: TaskRecord, frame: ReturnType<typeof controlledFrame>): boolean {
    return !isTerminal(root.status) && frame.complete && root.control?.mode === 'pause' && root.control.acknowledged === false
        && Number.isSafeInteger(root.control.epoch) && root.control.epoch >= 0
        && !frame.tasks.some(task => Object.values(task.effects ?? {}).some(effect => effect.cleanupPending));
}

function controlledFrame(snapshot: DurableFlowSnapshot) {
    const root = snapshot.root.task, ids = new Set([root.id, ...snapshot.controlTaskIds ?? []]);
    const records = new Map(snapshot.taskTree.map(task => [task.id, task])); records.set(root.id, root);
    const complete = snapshot.controlTaskIds !== undefined && [...ids].every(id => records.has(id));
    return {ids, complete, tasks: [...ids].flatMap(id => records.get(id) ?? [])};
}

function controlIdentity(task: TaskRecord, stopped?: boolean): unknown[] {
    return [task.id, task.status, task.control?.mode, task.control?.epoch, task.control?.acknowledged,
        task.sessionPaused, task.controlHolds, stopped, Object.values(task.effects ?? {}).some(effect => effect.cleanupPending)];
}
function isTerminal(status: string): boolean {return ['succeeded', 'failed', 'cancelled'].includes(status);}


/** Historical attempts remain readable but do not offer executable interactions. */
export function invocationControlTasks(snapshot: DurableFlowSnapshot): TaskRecord[] {
    return controlledFrame(snapshot).tasks;
}
