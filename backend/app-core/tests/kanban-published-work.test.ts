import {expect, it, vi} from 'vitest';
import type {IndependentCallView, IndependentCallInput} from '@itookit/llm-session/contracts';
import type {KanbanDispatch, KanbanItem} from '@itookit/kanban/contracts';
import type {TaskRecord} from '@itookit/durable-kernel';
import {createPublishedKanbanWorkExecutor, type PublishedKanbanWorkOptions} from '../src/kanban/published-work';
const dispatch:KanbanDispatch={id:'dispatch',itemId:'item',itemRevision:1,planId:'plan',planRevision:1,principal:{kind:'service',id:'worker'},definitionDigest:'a'.repeat(64),attempt:1,fence:'fence',preparedAt:1,outcome:'prepared',inputs:{}};
async function fixture() {
    type Calls=PublishedKanbanWorkOptions['calls'];
    const calls={prepareTaskCall:vi.fn<Calls['prepareTaskCall']>(),submitPreparedTaskCall:vi.fn<Calls['submitPreparedTaskCall']>(),inspectTaskCallSubmission:vi.fn<Calls['inspectTaskCallSubmission']>(),list:vi.fn<Calls['list']>()};
    const record={id:'caller',sessionId:'session',version:1,effects:{},exit:{status:'succeeded',output:{exit:{status:'succeeded'}}}} as unknown as TaskRecord;
    const task=vi.fn(async()=>record),prepareSession=vi.fn(async()=> 'session');
    const executor=createPublishedKanbanWorkExecutor({calls,kernel:{task},prepareSession,binding:async()=>({target:{kind:'agent',id:'published-agent',version:'1',digest:'b'.repeat(64)}})});
    const frozen=await executor.prepare(dispatch,{id:'item',title:'Task'} as KanbanItem) as {input: IndependentCallInput};
    const admission={submission:{task:{sessionId:'session',taskId:'caller'}}} as Awaited<ReturnType<Calls['inspectTaskCallSubmission']>>;
    calls.inspectTaskCallSubmission.mockResolvedValue(admission);
    const view={input:{request:{submission:{id:dispatch.id}}},callerState:{settled:true},executionTree:{settled:true}} as IndependentCallView;
    calls.list.mockResolvedValue([view]);
    return {calls,executor,frozen,task,record,view,prepareSession};
}
it('only accepts settled caller and execution-tree facts, without submitting or preparing on inspection',async()=>{
    const f=await fixture();f.view.executionTree!.settled=false;
    expect(await f.executor.inspect(f.frozen)).toEqual({outcome:'unknown',code:'WORK_EXECUTION_UNSETTLED'});expect(f.task).not.toHaveBeenCalled();
    f.view.executionTree!.settled=true;
    expect(await f.executor.inspect(f.frozen)).toEqual({outcome:'succeeded',outputs:[]});
    expect(f.calls.prepareTaskCall).not.toHaveBeenCalled();expect(f.calls.submitPreparedTaskCall).not.toHaveBeenCalled();expect(f.prepareSession).toHaveBeenCalledTimes(1);
});
it('does not treat a missing receipt, pending effects or failed child result as successful work',async()=>{
    const f=await fixture();f.calls.inspectTaskCallSubmission.mockResolvedValueOnce(undefined);
    expect(await f.executor.inspect(f.frozen)).toMatchObject({outcome:'unknown',code:'WORK_ADMISSION_UNKNOWN'});
    f.record.effects={pending:{status:'indeterminate'}} as TaskRecord['effects'];
    expect(await f.executor.inspect(f.frozen)).toMatchObject({outcome:'unknown',code:'WORK_CALLER_UNSETTLED'});
    f.record.effects={};f.record.exit={status:'failed',error:{code:'EFFECT_TIMEOUT',message:'private failure detail'}};
    expect(await f.executor.inspect(f.frozen)).toMatchObject({outcome:'failed',code:'EFFECT_TIMEOUT'});
    f.record.exit={status:'succeeded',output:{exit:{status:'failed'}}};
    expect(await f.executor.inspect(f.frozen)).toMatchObject({outcome:'failed',code:'WORK_EXECUTION_FAILED'});
});
it('prepares before submission and propagates response loss for unknown reconciliation',async()=>{
    const f=await fixture();f.calls.submitPreparedTaskCall.mockRejectedValueOnce(new Error('response lost'));
    await expect(f.executor.start(f.frozen)).rejects.toThrow('response lost');
    expect(f.calls.prepareTaskCall).toHaveBeenCalledWith(f.frozen.input,{maxDepth:4, timeoutMs:null});
    expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledWith(f.frozen.input);
    f.calls.prepareTaskCall.mockRejectedValueOnce(Object.assign(new Error('private parameters'),{code:'TARGET_NOT_PUBLISHED'}));
    expect(await f.executor.start(f.frozen)).toEqual({outcome:'failed',code:'TARGET_NOT_PUBLISHED'});expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(1);
});
it('reports the execution Session identity without exposing internal Task data',async()=>{
    const f=await fixture();
    f.calls.inspectTaskCallSubmission.mockResolvedValueOnce({executionSessionId:'execution-child',submission:{task:{sessionId:'caller-session',taskId:'private-task-id'}}} as never);
    f.view.callerState!.settled=false;
    const result=await f.executor.inspect(f.frozen);expect(result).toEqual({executionSessionId:'execution-child',outcome:'running'});
    expect(JSON.stringify(result)).not.toContain('private-task-id');
});
