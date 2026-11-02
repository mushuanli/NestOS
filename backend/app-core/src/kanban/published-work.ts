import type {IndependentCallService} from '@itookit/llm-session';
import type {IndependentCallInput, IndependentCallView} from '@itookit/llm-session/contracts';
import type {TargetRef} from '@itookit/llm-flow/contracts';
import {taskStat, type Kernel, type TaskCallResult} from '@itookit/durable-kernel';
import type {KanbanArtifactRef, KanbanDispatch, KanbanItem} from '@itookit/kanban/contracts';
import type {KanbanExecutionPort, KanbanExecutionObservation} from '@itookit/kanban/execution';
import {KanbanError} from '@itookit/kanban';
interface WorkExecutionPolicy {maxDepth: number; timeoutMs?: number | null}
interface FrozenWork {schema: 1; dispatch: KanbanDispatch; input: IndependentCallInput; policy: WorkExecutionPolicy}
export interface PublishedKanbanWorkOptions {
    observe?(dispatch: KanbanDispatch, observation: KanbanExecutionObservation): Promise<KanbanExecutionObservation>;
    calls: Pick<IndependentCallService,'prepareTaskCall'|'submitPreparedTaskCall'|'inspectTaskCallSubmission'|'list'>; kernel: Pick<Kernel,'task'>;
    /** Stable Session preparation is owned by the host's existing session journal. */
    prepareSession(dispatchId: string): Promise<string>;
    binding(dispatch: KanbanDispatch, item: KanbanItem): Promise<{target: TargetRef; overrides?: IndependentCallInput['request']['overrides']}>;
    context?(dispatch: KanbanDispatch, item: KanbanItem): Promise<unknown>;
    outputs?(dispatch: KanbanDispatch, result: TaskCallResult): Promise<KanbanArtifactRef[]>;
    executionPolicy?: WorkExecutionPolicy;
}
/** Reuses the published Task-call admission and read-only execution-tree observation. */
export function createPublishedKanbanWorkExecutor(options: PublishedKanbanWorkOptions): KanbanExecutionPort {
    return {
        async prepare(dispatch: KanbanDispatch, item: KanbanItem): Promise<FrozenWork> {
            const sessionId=await options.prepareSession(dispatch.id), binding=await options.binding(dispatch, item);
            const input: IndependentCallInput={title:'Kanban work', request:{expectedSessionId:sessionId,expectedBranch:'main',expectedTarget:binding.target,
                target:{kind:binding.target.kind,id:binding.target.id,version:binding.target.version},overrides:binding.overrides,
                source:{kind:'composer',text:JSON.stringify({item,inputs:dispatch.inputs,dependencies:await options.context?.(dispatch,item),planId:dispatch.planId,planRevision:dispatch.planRevision}),attachments:[],values:{}},
                submission:{id:dispatch.id,source:{kind:'conversation',ownerId:sessionId,id:dispatch.id}}}};
            return {schema:1,dispatch:structuredClone(dispatch),input,policy:structuredClone(options.executionPolicy ?? {maxDepth:4, timeoutMs: null})};
        },
        async start(value) {
            const frozen=validateFrozen(value);
            try {await options.calls.prepareTaskCall(frozen.input,frozen.policy);}
            catch(error) {return {outcome:'failed',code:knownCode(error,'WORK_PREPARATION_FAILED')};}
            await options.calls.submitPreparedTaskCall(frozen.input);
            const observation = await inspectWork(options,frozen);
            return options.observe ? options.observe(frozen.dispatch, observation) : observation;
        },
        inspect: async value => {const frozen = validateFrozen(value), observation = await inspectWork(options, frozen);
            return options.observe ? options.observe(frozen.dispatch, observation) : observation;},
    };
}
async function inspectWork(options: PublishedKanbanWorkOptions, frozen: FrozenWork): Promise<KanbanExecutionObservation> {
    const admission=await options.calls.inspectTaskCallSubmission(frozen.input);
    if(!admission) return {outcome:'unknown',code:'WORK_ADMISSION_UNKNOWN'};
    const views=await options.calls.list({sessionId:frozen.input.request.expectedSessionId!,branchId:frozen.input.request.expectedBranch});
    const view=views.find(view=>view.input.request.submission?.id===frozen.dispatch.id);
    const session=admission.executionSessionId?{executionSessionId:admission.executionSessionId}:{};
    if(!view) return {...session,outcome:'unknown',code:'WORK_EXECUTION_VIEW_MISSING'};
    if(view.callerState&&!view.callerState.settled) return {...session,outcome:'running'};
    if(!treeSettled(view)) return {...session,outcome:'unknown',code:'WORK_EXECUTION_UNSETTLED'};
    const record=await options.kernel.task(admission.submission.task.sessionId,admission.submission.task.taskId), stat=taskStat(record);
    if(!stat.settled||!record.exit) return {...session,outcome:'unknown',code:'WORK_CALLER_UNSETTLED'};
    if(record.exit!.status!=='succeeded') return {...session,outcome:record.exit!.status==='cancelled'?'cancelled':'failed',code:knownCode(record.exit.error,'WORK_CALLER_FAILED')};
    const result=record.exit!.output as TaskCallResult|undefined;
    if(!result?.exit) return {...session,outcome:'unknown',code:'WORK_RESULT_MISSING'};
    if(result.exit.status!=='succeeded') return {...session,outcome:result.exit.status==='cancelled'?'cancelled':'failed',code:knownCode(result.exit.error,'WORK_EXECUTION_FAILED')};
    return {...session,outcome:'succeeded',outputs:await options.outputs?.(frozen.dispatch,result) ?? []};
}
function treeSettled(view: IndependentCallView): boolean {return view.callerState?.settled===true&&view.executionTree?.settled===true;}
function validateFrozen(value: unknown): FrozenWork {
    const frozen=value as FrozenWork;
    if(frozen?.schema!==1||!frozen.dispatch?.id||!frozen.policy||frozen.input?.request?.submission?.id!==frozen.dispatch.id) throw new KanbanError('INVALID_FROZEN_EXECUTION');return frozen;
}
function knownCode(error: unknown, fallback: string): string {const code=(error as {code?:unknown})?.code;return typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:fallback;}
