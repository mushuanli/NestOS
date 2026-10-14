import { expect,it,vi } from 'vitest';
import { compareSyncConflict } from '../src/shared/comparison';
import { bindingToken,SyncError,sha256,type StoredFilePlan } from '@itookit/vfs-sync';
import { MemoryState } from '../../../tests/helpers/sync';

async function fixture(left: Uint8Array = new TextEncoder().encode('local\n'),right: Uint8Array = new TextEncoder().encode('remote\n')) {
    const state=new MemoryState(),a=await sha256(left),b=await sha256(right);
    const plan:StoredFilePlan={id:'plan',bindingToken:bindingToken(state.state.binding),scopeToken:'scope',changesCursor:'cursor',head:{generation:'1',manifestHash:b},lifecycleRevision:'1',phase:'prepared',handle:{},
        plan:{manifest:{format:'fs-agent.files',version:1,entries:[]},actions:[],degraded:[],conflicts:[{path:'note',code:'CONTENT_CONFLICT',local:{kind:'file',path:'note',hash:a,size:String(left.length)},remote:{kind:'file',path:'note',hash:b,size:String(right.length)}}]}};
    const store=Object.assign(state,{plan:vi.fn(async()=>plan),object:vi.fn(async(hash:string)=>hash===a?left:right)});
    return {state,store,plan};
}
it('reads the immutable captured versions without substituting later working content',async()=>{
    const {store}=await fixture();const result=await compareSyncConflict(store,'plan','note');
    expect(result.local.content?.text).toBe('local\n');expect(result.remote.content?.text).toBe('remote\n');expect(result.baseline.kind).toBe('missing');
});
it('rejects stale binding tokens and paths outside the captured conflict',async()=>{
    const {state,store}=await fixture();await expect(compareSyncConflict(store,'plan','other')).rejects.toThrow('INVALID_CONFLICT_PATH');
    state.state.binding.policyRevision='2';await expect(compareSyncConflict(store,'plan','note')).rejects.toThrow('PLAN_STALE');
    expect(store.object).not.toHaveBeenCalled();
});
it('bounds text reads and identifies binary content',async()=>{
    const {store}=await fixture(new Uint8Array([0,1,2]),new Uint8Array(256*1024+1));
    const result=await compareSyncConflict(store,'plan','note');expect(result.local.content?.reason).toBe('binary');expect(result.remote.content?.reason).toBe('too-large');
    expect(store.object).toHaveBeenCalledTimes(1);
});
it('distinguishes an unavailable baseline from corrupt storage',async()=>{
    const {store,plan}=await fixture();plan.plan.conflicts[0].baseline={kind:'file',path:'note',hash:'old',size:'3'};
    const read=store.object.getMockImplementation()!;store.object.mockImplementation(async hash=>{if(hash==='old')throw new SyncError('LOCAL_OBJECT_MISSING');return read(hash);});
    expect((await compareSyncConflict(store,'plan','note')).baseline.content?.reason).toBe('unavailable');
    store.object.mockRejectedValue(new SyncError('LOCAL_OBJECT_CORRUPT'));await expect(compareSyncConflict(store,'plan','note')).rejects.toThrow('LOCAL_OBJECT_CORRUPT');
});
