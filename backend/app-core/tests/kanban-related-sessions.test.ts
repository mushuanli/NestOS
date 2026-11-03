import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {sha256HexSync} from '@itookit/common';
import type {KanbanItem, KanbanBoard, KanbanWorkflowState} from '@itookit/kanban/contracts';
import {KanbanAutomationJournal} from '../src/kanban/automation-journal';
import {relatedKanbanSessions} from '../src/kanban/related-sessions';
import {analysisHistory} from '../src/kanban/automation-analysis';
import {relatedExecutionReader} from '../src/kanban/related-session-executions';
import {developmentSessionResources} from '../src/presets/kanban-work-resources';
import {harnessExecutionJournalKey} from '../src/projects/harness-execution-journal';
import {developmentLifecycleSessions} from '../src/presets/kanban-development-lifecycle';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend:new MemoryBackend()}); closes.push(()=>manager.dispose());
    const fs = await manager.openFileSystem('/'), journal = new KanbanAutomationJournal(fs); await journal.open();
    const bodies = new Map<string,string>(), shared = new Map<string,unknown>(), tasks = new Map<string,unknown[]>();
    const repository = {readDocument:vi.fn(async (session: string, path: string)=>bodies.get(session+'/'+path))};
    const kernel = {inspectSession:vi.fn(async (session:string)=>({snapshot:async()=>({tasks:tasks.get(session)??[]}),
        getShared:async(key:string)=>shared.has(session+'/'+key)?{version:1,value:shared.get(session+'/'+key)}:undefined}))};
    const calls = {inspectTaskCallSubmission:vi.fn(async (input:any)=>({executionSessionId:'node-'+input.request.expectedSessionId}))};
    return {fs,journal,bodies,shared,tasks,repository,kernel,calls};
}
const board = {id:'b'} as KanbanBoard;
const item = {id:'work',externalRefs:[{system:'nestos-execution-session',id:'main',revision:'d1'},
    {system:'nestos-execution-session',id:'main',revision:'d2'},{system:'nestos-fix-session',id:'fix',revision:'fix-round'}]} as KanbanItem;
const workflow = {dispatches:{d1:{id:'d1',itemId:'work'},d2:{id:'d2',itemId:'work'}}} as unknown as KanbanWorkflowState;
async function analysis(journal:KanbanAutomationJournal, boardId:string, id:string, revision:number) {
    const signature='sig',key='analysis:'+sha256HexSync(JSON.stringify([boardId,'work',revision,signature]));
    await journal.update(key,()=>({id,itemRevision:revision,signature,status:{itemId:'work',state:'ready'},
        input:{request:{expectedSessionId:id,submission:{id},source:{text:'PRIVATE_PROMPT'}}}}));
    return key;
}
it('recovers all legacy planning Sessions within board/item scope and keeps only actual child Sessions',async()=>{
    const f=await fixture();
    const key1=await analysis(f.journal,'b','planner-1',1),key2=await analysis(f.journal,'b','planner-2',2);
    await analysis(f.journal,'other-board','foreign',1);
    await f.journal.update('analysis-current:'+JSON.stringify(['b','work']),()=>key2);
    await f.journal.update('development-lifecycle-index',()=>['hook','foreign-hook','child-hook']);
    for(const [key,boardId,itemId] of [['hook','b','work'],['foreign-hook','other-board','work'],['child-hook','b','child']])
        await f.journal.update(key,()=>({id:key,boardId,dispatch:{itemId},request:{input:{request:{expectedSessionId:key,submission:{id:key}}}}}));
    const related=relatedKanbanSessions({...f, related: (boardId: string, itemId: string) => developmentLifecycleSessions(f as never, boardId, itemId)} as never);
    const rows=await related(board,item,workflow);
    expect(rows.map(row=>[row.sessionId,row.purpose]).sort()).toEqual([
        ['main','execution'],['main','execution'],['fix','fix'],['node-planner-1','planning'],['node-planner-2','planning'],['node-hook','finalization'],
    ].sort());
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_PROMPT');
    expect(rows.some(row=>row.sessionId==='planner-1'||row.sessionId==='foreign')).toBe(false);
    expect(await f.journal.get('analysis-history:'+JSON.stringify(['b','work']))).toEqual({keys:[key1,key2].sort(),indexed:true});
    const reopened=new KanbanAutomationJournal(f.fs); await reopened.open();
    expect((await analysisHistory(reopened,'b','work')).map(row=>row.id).sort()).toEqual(['planner-1','planner-2']);
});
it('projects each Round and native turn separately, using Kernel facts while preserving retained resource associations',async()=>{
    const f=await fixture(), invocation=(id:string)=>({invocationId:id});
    f.bodies.set('main/round-d1.json',JSON.stringify({id:'d1',sessionId:'main',status:'failed',createdAt:10,completedAt:20,
        executions:[{role:'primary',taskId:'t1',invocation:invocation('i1')}],input:[{content:'PRIVATE_INPUT'}],output:[{content:'PRIVATE_OUTPUT'}]}));
    f.bodies.set('main/round-d2.json',JSON.stringify({id:'d2',sessionId:'main',status:'failed',createdAt:30,completedAt:31,
        executions:[{role:'primary',taskId:'t2',invocation:invocation('i2')}],error:'PRIVATE_ERROR'}));
    f.tasks.set('main',[{id:'t1',sessionId:'main',version:1,effects:{},labels:{roundId:'d1',invocationId:'i1'},exit:{status:'failed',completedAt:21}},
        {id:'t2',sessionId:'main',status:'running',version:1,effects:{},labels:{roundId:'d2',invocationId:'i2'}}]);
    const operation={operationId:'op-2',fingerprint:'digest',invocationId:'i2',executionRef:{taskId:'t2',effectId:'effect'}};
    f.shared.set('main/harness.context.bindings',{version:1,sessionId:'main',bindings:{binding:{id:'binding',sessionId:'main',revision:1,
        generation:1,branchId:'main',connectionId:'connection',connectionRef:'connection-ref',targetRef:'agent:1',scopeRef:'scope',policyRef:'policy',workspaceRef:'workspace',memoryPolicyRef:'memory',
        validity:'pending',initialContext:{mode:'host-assembled',snapshotRef:'input',digest:'digest'},knownHeadRef:'turn-1',
        checkpoints:[{kind:'terminal',ref:'turn-1',operation:{operationId:'op-1',fingerprint:'digest',invocationId:'i1',executionRef:{taskId:'t1',effectId:'effect'}}}],activeOperation:operation}}});
    f.shared.set('main/'+harnessExecutionJournalKey({sessionId:'main',taskId:'t2',effectId:'effect'}),
        {owner:['main','t2','effect'],bindingId:'binding',turnId:'turn-2'});
    await f.journal.update('worktree:d1',()=>({id:'original-tree',directory:'/workspace/tree',branch:'work/original-tree'}));
    await f.journal.update('worktree:d2',()=>({id:'original-tree',directory:'/workspace/tree',branch:'work/original-tree'}));
    const reader=relatedExecutionReader({...f,resources:id=>developmentSessionResources(f.journal,id)} as never);
    const first=await reader('main',{id:'d1',purpose:'execution'}),second=await reader('main',{id:'d2',purpose:'execution'});
    expect(first).toMatchObject({roundId:'d1',turnId:'turn-1',state:'failed',completedAt:21});
    expect(second).toMatchObject({roundId:'d2',turnId:'turn-2',state:'running'});expect(second.completedAt).toBeUndefined();
    expect(first.resources).toEqual(second.resources);expect(first.resources?.[0].value).toBe('original-tree');
    expect(JSON.stringify([first,second])).not.toContain('PRIVATE_');
    expect(f.kernel.inspectSession.mock.calls.filter(([id])=>id==='main')).toHaveLength(3);
});
it('does not fabricate a Round for rejected admissions and rejects mismatched Round identity',async()=>{
    const f=await fixture(),reader=relatedExecutionReader(f as never);
    expect(await reader('main',{id:'unstarted',purpose:'execution'})).toEqual({id:'unstarted',purpose:'execution'});
    expect(f.kernel.inspectSession).not.toHaveBeenCalled();
    f.bodies.set('main/round-mismatch.json',JSON.stringify({id:'mismatch',sessionId:'another-session',status:'completed'}));
    await expect(reader('main',{id:'mismatch',purpose:'execution'})).rejects.toMatchObject({code:'SESSION_RELATION_SCOPE_MISMATCH'});
    await expect(reader('main',{id:'../../secret',purpose:'execution'})).rejects.toMatchObject({code:'SESSION_RELATION_ID_INVALID'});
});
