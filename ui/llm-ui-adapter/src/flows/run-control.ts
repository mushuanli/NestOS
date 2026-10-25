import {createModuleLogger, t} from '@itookit/common';
import {FlowCommand, type DurableFlowSnapshot} from '@itookit/llm-flow/contracts';
import type {ICommandBus} from '@itookit/llm-session/contracts';
import {ControlOperations, type ControlInput} from './control-operations';
import {invocationControl} from './invocation-control';

const log = createModuleLogger('invocation-control');
export interface PauseResult {limitedRecovery?: true; retainedTaskIds?: string[]}

/** Shared control admission for call cards and the standalone run viewer. */
export class FlowRunControl {
    constructor(private commands: ICommandBus, private sessionId: string, private operations: ControlOperations) {}
    async execute(taskId: string, action: ControlInput['action'], expectedEpoch: number,
        current: () => boolean): Promise<PauseResult | undefined> {
        const started = Date.now();
        let result: PauseResult | undefined;
        await this.operations.run({protocol: 'flow-control-v1', taskId, action, expectedEpoch, executionSessionId: this.sessionId}, async requestId => {
            if (!current()) return false;
            try {
                const snapshot = await this.prepare(taskId, action, expectedEpoch, current);
                if (!snapshot || !current()) return false;
                const args = {taskId, requestId, expectedEpoch};
                result = action === 'withdraw'
                    ? await this.commands.execute(FlowCommand.RunPauseWithdraw, args)
                    : await this.commands.execute(FlowCommand.RunGoalUpdate, {...args, goal: {status: action === 'pause' ? 'paused' : 'active'}});
                controlDiagnostic(action, requestId, started); return true;
            } catch (error) {controlDiagnostic(action, requestId, started, error); throw error;}
        });
        return result;
    }
    private async prepare(taskId: string, action: ControlInput['action'], epoch: number,
        current: () => boolean): Promise<DurableFlowSnapshot | undefined> {
        const read = () => this.commands.execute<DurableFlowSnapshot>(FlowCommand.RunGet, {taskId, sessionId: this.sessionId});
        let snapshot = await read();
        if (!current()) return;
        this.assertAction(snapshot, action, epoch);
        if (action !== 'pause' && snapshot.attachedFromStorage && !invocationControl(snapshot).externalHold) {
            await this.commands.execute(FlowCommand.RunResume, {taskId, sessionId: this.sessionId});
            if (!current()) return;
            snapshot = await read();
            if (!current()) return;
            this.assertAction(snapshot, action, epoch);
        }
        return snapshot;
    }
    private assertAction(snapshot: DurableFlowSnapshot, action: ControlInput['action'], epoch: number): void {
        if (snapshot.root.task.sessionId && snapshot.root.task.sessionId !== this.sessionId)
            throw Object.assign(new Error('Flow control execution Session mismatch'), {code: 'FLOW_INVOCATION_EXECUTION_SCOPE'});
        const control = invocationControl(snapshot);
        if (control.terminal) throw new Error(t('flow.rerun.unavailable'));
        assertControlEpoch(snapshot, epoch);
        if (action === 'pause' && !control.supportsPause) throw new Error(t('flow.invoke.legacyPause'));
        if (action === 'resume' && !control.canRelease) throw new Error(t('flow.invoke.pauseUnconfirmed'));
        if (action === 'withdraw') assertWithdraw(snapshot, epoch);
    }
}

function assertWithdraw(snapshot: DurableFlowSnapshot, expectedEpoch: number): void {
    if (!invocationControl(snapshot).canWithdraw || snapshot.root.task.control?.epoch !== expectedEpoch)
        throw Object.assign(new Error(t('flow.invoke.pauseChanged')), {code: 'FLOW_PAUSE_CHANGED'});
}

function assertControlEpoch(snapshot: DurableFlowSnapshot, expectedEpoch: number): void {
    if ((snapshot.root.task.control?.epoch ?? 0) !== expectedEpoch)
        throw Object.assign(new Error(t('flow.invoke.pauseChanged')), {code: 'FLOW_PAUSE_CHANGED'});
}

function controlDiagnostic(action: string, identity: string, started: number, error?: unknown): void {
    const code = (error as {code?: unknown})?.code;
    const data = {operation: `flow.control.${action}`, operationId: /^[\w:-]{1,256}$/.test(identity) ? identity : undefined,
        stage: 'control', result: error ? 'failure' : 'accepted', durationMs: Date.now() - started,
        ...(error ? {code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'FLOW_CONTROL_FAILED'} : {})};
    try {if (error) log.warn('Flow invocation control', data); else log.info('Flow invocation control', data);}
    catch { /* Diagnostics must not change a control result. */ }
}
