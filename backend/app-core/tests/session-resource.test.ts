import {expect,it,vi} from 'vitest';
import type {ProjectService} from '@itookit/app-contracts/services';
import type {ProjectRemoteMountService} from '../src/projects/remote-mounts';
import {nativeSessionResource} from '../src/projects/session-resource';
import {HarnessContextBindings} from '../src/projects/harness-context-bindings';
import {durableState,request} from './harness-execution-fixture';
import {context,operation} from './harness-context-fixture';
async function fixture(){
    const f=durableState(),store=new HarnessContextBindings(f.state,'s');
    const add=async(id:string)=>{
        await store.claim(id,context,request.connection,operation);
        await store.attach(id,operation.operationId,{nodeConnectionId:'node',profileId:'codex',workspaceId:'workspace',epoch:'epoch',sessionId:'native-'+id});
        const staged=await store.prepareSettlement(id,operation.operationId,{operationId:operation.operationId,kind:'terminal',knownHeadRef:'head'});
        await store.release(id,operation.operationId,staged.revision+1);
    };
    await add('one');
    const kernel={inspectSession:vi.fn(async()=>({getShared:<T extends import('@itookit/durable-kernel').JsonValue>(key:string)=>f.state.get<T>(key)}))};
    const projects={list:vi.fn(async()=>[{path:'/x1',project:{id:'x1'}}])} as unknown as Pick<ProjectService,'list'>;
    const remote={list:vi.fn(()=>[{at:'/',connectionId:'node',serverProjectId:'workspace'}])} as unknown as Pick<ProjectRemoteMountService,'list'>;
    return {...f,add,kernel,projects,remote,resolve:nativeSessionResource(kernel,projects,remote)};
}
it('opens the original native context by authorized project identity without executing or writing',async()=>{
    const f=await fixture(),writes=[...f.writes];
    expect(await f.resolve('s','main')).toBe('/folder:x1/@harness/codex/native-one');
    expect(f.writes).toEqual(writes);expect(await f.resolve('s','other')).toBeUndefined();
});
it('does not guess when multiple contexts or no authorized project match',async()=>{
    const f=await fixture();vi.mocked(f.remote.list).mockReturnValue([]);
    expect(await f.resolve('s','main')).toBeUndefined();
    await f.add('two');expect(await f.resolve('s','main')).toBeUndefined();
});
