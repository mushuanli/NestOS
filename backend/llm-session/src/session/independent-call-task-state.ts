import {taskStat, type TaskRecord} from '@itookit/durable-kernel';
import {hasFlowControlTree} from '@itookit/llm-flow/contracts';
import type {IndependentCallExecutionState} from '../contracts/independent-calls';

export function independentCallTaskState(task: TaskRecord): IndependentCallExecutionState {
    const {id, revision, phase, control, blockedBy, activeOperations, settled, stopped} = taskStat(task);
    return {id, revision, phase, control, blockedBy, activeOperations, settled, stopped, controlEpoch: task.control?.epoch ?? 0,
        ...(task.exit ? {exitStatus: task.exit.status} : {})};
}
export function supportsCallCancellation(task: TaskRecord): boolean {
    return task.program.kind !== 'flow.aggregate' && task.labels?.kind !== 'flow-root' || hasFlowControlTree(task);
}
