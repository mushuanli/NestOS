import type {SessionHandle, TaskHandle, TaskRecord} from '@itookit/durable-kernel';
import {readFlowRunMembers} from './run-members';
import {assertCurrentFlowControl, flowControlError} from './control-tree';

export interface FlowControlRecovery {
    limitedRecovery?: true;
    retainedTaskIds?: string[];
}

/** Only release a legacy batch pause whose earlier running state can still be proved. */
export async function recoverLegacyFlowPause(session: SessionHandle, root: TaskRecord, requestId: string,
    expectedEpoch?: number): Promise<FlowControlRecovery> {
    if (root.control?.mode === 'interrupt') throw flowControlError('FLOW_CONTROL_TREE_UNAVAILABLE',
        'Legacy interruption requires its original Task recovery; Session controls remain available');
    if (root.control?.mode === 'pause') await releaseLegacyMembers(session, root, requestId, expectedEpoch);
    const handle = await session.attachTask(root.id), control = await handle.resume({requestId, expectedEpoch});
    assertCurrentFlowControl((await handle.status()).task, control);
    const retainedTaskIds: string[] = [];
    for (const member of await readFlowRunMembers(session, root)) {
        const task = (await (await session.attachTask(member.taskId)).status()).task;
        if (!task.exit && task.control?.mode === 'pause') retainedTaskIds.push(task.id);
    }
    return {limitedRecovery: true, retainedTaskIds};
}

async function releaseLegacyMembers(session: SessionHandle, root: TaskRecord, requestId: string, expectedEpoch?: number): Promise<void> {
    if (expectedEpoch !== undefined && expectedEpoch !== root.control!.epoch)
        throw flowControlError('CONFLICT', 'Control epoch conflict');
    for (const member of await readFlowRunMembers(session, root)) {
        const handle = await session.attachTask(member.taskId), task = (await handle.status()).task;
        if (task.exit || task.control?.mode !== 'pause') continue;
        if (task.control.requestId !== root.control!.requestId || !await wasRunningBeforeBatchPause(handle, task)) continue;
        await handle.resume({requestId, expectedEpoch: task.control.epoch});
    }
}

async function wasRunningBeforeBatchPause(handle: TaskHandle, task: TaskRecord): Promise<boolean> {
    const history = (await handle.history({afterVersion: Math.max(-1, task.version - 256)})).sort((a, b) => a.version - b.version);
    const first = history.find(row => row.control?.mode === 'pause' && row.control.requestId === task.control!.requestId);
    if (!first) return false;
    const previous = history.filter(row => row.version < first.version).at(-1);
    return !!previous && (!previous.control || previous.control.mode === 'run');
}
