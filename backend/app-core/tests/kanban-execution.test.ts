import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {createKanbanModule, SeqKanbanStore, type KanbanCommand, type KanbanModuleHandle} from '@itookit/kanban';
import {createNestOSKanbanExecutionBridge} from '../src/kanban';
import type {KanbanExecutionPort} from '@itookit/kanban/execution';
const closes: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse()) await close();});
async function fixture() {
    const backend=new MemoryBackend(),{manager}=await createVFS({rootBackend:backend});closes.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs), log=vi.fn();
    const api=(id:string)=>createKanbanModule({store,actor:{kind:'service',id},authorize:async()=>{},log});
    const service=api('manager'),worker=api('worker');let serial=0;
    await service.create({id:'b',title:'Work',scope:{kind:'system'},members:[{kind:'service',id:'manager',responsibility:'Manage',roles:['coordinator','reviewer']},{kind:'service',id:'worker',responsibility:'Build',roles:['worker']}],policy:{requireEstimate:false,review:'independent'}});
    const run=async(command:KanbanCommand,actor:KanbanModuleHandle=service)=>actor.execute('b',{operationId:`op-${++serial}`,expectedRevision:(await actor.read('b')).revision,command});
    await run({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'p',revision:1,sealed:true,items:['first','second'].map((id,i)=>({id,title:id,responsibility:'Work',acceptance:'Done',assignee:{kind:'service',id:'worker'},dependsOn:i?['first']:[]}))}});
    const executor:KanbanExecutionPort={prepare:vi.fn(async dispatch=>({dispatchId:dispatch.id})),start:vi.fn(async()=>({outcome:'running'})),inspect:vi.fn(async()=>({outcome:'unknown',code:'RECEIPT_MISSING'}))};
    const bridge=async()=>{
        const bridge=await createNestOSKanbanExecutionBridge({fs,directory:'/bridge',boardId:'b',service,worker:async()=>worker,executor,authorize:async()=>{},log,shutdownTimeoutMs:5});
        closes.push(()=>bridge.quiesce());return bridge;
    };
    const prepare=()=>run({type:'prepare-dispatch',itemId:'first',dispatchId:'d'},worker);
    return {service,executor,bridge,prepare};
}
it('links the actual execution Session to the work item once, retaining the dispatch identity',async()=>{
    const f=await fixture();await f.prepare();vi.mocked(f.executor.start).mockResolvedValueOnce({outcome:'running',executionSessionId:'execution-session'});
    const bridge=await f.bridge();await bridge.scan();
    expect((await f.service.item('b','first')).item.externalRefs).toEqual([{system:'nestos-execution-session',id:'execution-session',revision:'d'}]);
    vi.mocked(f.executor.inspect).mockResolvedValueOnce({outcome:'running',executionSessionId:'execution-session'});await bridge.scan();
    expect((await f.service.item('b','first')).item.externalRefs).toHaveLength(1);expect(f.executor.start).toHaveBeenCalledTimes(1);
});
