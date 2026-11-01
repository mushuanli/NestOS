import {expect,it,vi} from 'vitest';
import type {SessionActivity,EventEnvelope} from '@itookit/durable-kernel/contracts';
import {createLocalKanbanSessionSource,sessionPhase} from '../src/kanban/session-source';
function activity():SessionActivity {
    return {sessionId:'execution',sessionStatus:'open',revision:1,asOfSequence:3,counts:{running:0,queued:0,created:0,waiting:0,paused:0,blocked:0,succeeded:0,failed:0,cancelled:0},pending:{approval:0,input:0,cleanup:0}};
}
it('reads only execution Session metadata, excluding event bodies and manifest edits',async()=>{
    const state=activity();state.counts.running=1;state.lastActivityAt=100;
    const events=[{sessionId:'execution',taskId:'internal',type:'task.started',occurredAt:100},{sessionId:'execution',taskId:'internal',type:'task.events.pruned',occurredAt:800},{sessionId:'execution',type:'session.identity.assigned',occurredAt:900}] as EventEnvelope[];
    const repository={getManifest:vi.fn(async()=>({id:'execution',title:'Execution',updatedAt:1000}))},kernel={sessionActivity:vi.fn(async()=>state),readEvents:vi.fn(async()=>({items:events,throughSequence:3}))};
    const source=createLocalKanbanSessionSource(repository as never,kernel as never),result=await source.inspect({id:'board'} as never,'execution');
    expect(result).toMatchObject({sessionId:'execution',state:'running',lastActivityAt:100,stale:false});
    expect(JSON.stringify(result)).not.toContain('internal');expect(result).not.toHaveProperty('tasks');
    expect(kernel.readEvents).not.toHaveBeenCalled();
});
it('distinguishes Session waiting, pause, idle and completion without inferring completion from silence',()=>{
    const state=activity();expect(sessionPhase(state)).toBe('idle');state.counts.waiting=1;expect(sessionPhase(state)).toBe('waiting');
    state.pending.input=1;expect(sessionPhase(state)).toBe('waiting-input');state.pending.approval=1;expect(sessionPhase(state)).toBe('waiting-approval');
    state.counts.running=1;expect(sessionPhase(state)).toBe('running');state.counts.running=0;state.pending={approval:0,input:0,cleanup:0};state.counts.waiting=0;state.counts.paused=1;expect(sessionPhase(state)).toBe('paused');
    state.counts.paused=0;state.latestExit={status:'succeeded',at:1};expect(sessionPhase(state)).toBe('completed');
});
it('reports missing Session identity separately from storage failures during binding',async()=>{
    const repository={getManifest:vi.fn().mockRejectedValueOnce(Object.assign(new Error('private path'),{code:'ENOENT'})).mockRejectedValueOnce(Object.assign(new Error('storage unavailable'),{code:'EIO'}))};
    const source=createLocalKanbanSessionSource(repository as never,{sessionActivity:vi.fn()} as never);
    await expect(source.authorizeBinding!({id:'b'} as never,'missing')).rejects.toMatchObject({code:'SESSION_NOT_FOUND'});
    await expect(source.authorizeBinding!({id:'b'} as never,'missing')).rejects.toMatchObject({code:'EIO'});
});
