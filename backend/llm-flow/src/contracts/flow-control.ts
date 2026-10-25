import type {FlowRunGoal} from './flow-definition';

export interface FlowGoalUpdate {
    taskId: string;
    goal: Partial<FlowRunGoal>;
    requestId?: string;
    expectedEpoch?: number;
}

/** Capability comes from a frozen Run protocol marker, never a task kind or live UI state. */
export function hasFlowControlTree(root: {input?: unknown}): boolean {
    const input = root.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const initial = (input as {initialScheduler?: unknown}).initialScheduler;
    return !!initial && typeof initial === 'object' && !Array.isArray(initial)
        && (initial as {controlTreeVersion?: unknown}).controlTreeVersion === 1;
}
