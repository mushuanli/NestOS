import type {KanbanBoard, KanbanCommand, KanbanActor, KanbanService, KanbanExecutionSession, KanbanExternalReference, KanbanSessionItemSummary, KanbanWorkflowState} from './contracts';
import type {KanbanSessionSource} from './activity-ports';
import {principal,principalKey,candidates} from './identity';
import {KanbanError} from './ports';
import {querySessionItems} from './session-activity-query';
import {randomUUID} from './utils';
export interface KanbanSessionActivityOptions {source: KanbanSessionSource; now?:()=>number}
export function executionBindings(refs: KanbanExternalReference[] | undefined, referenceSystem: string) {return (refs ?? []).filter(ref=>ref.system===referenceSystem);}
function currentBinding(refs: KanbanExternalReference[]|undefined, itemId:string, workflow:KanbanWorkflowState, referenceSystem: string) {
    const binding=executionBindings(refs, referenceSystem).at(-1),latest=Object.values(workflow.dispatches).filter(dispatch=>dispatch.itemId===itemId).sort((a,b)=>b.attempt-a.attempt)[0];
    if(!binding||!latest||binding.revision===latest.id) return binding;
    return ['prepared','running','unknown','succeeded'].includes(latest.outcome)||workflow.dispatches[binding.revision ?? '']?undefined:binding;
}

/** Optional resource projection; access checks remain owned by the injected source. */
export function createKanbanSessionActivity(core: KanbanService, options: KanbanSessionActivityOptions | undefined, log: (event: {operationId:string;sessionId?:string;stage:string;result:'failure';code:string;durationMs:number})=>void, referenceSystem: string) {
    const inspect=createSessionInspector(options,log);
    const project=async(boardId:string,rows:KanbanSessionItemSummary[])=>{
        const [board,workflow]=await Promise.all([boardMetadata(core,boardId),core.workflow(boardId)]), bindings=new Map(rows.map(row=>[row.id,currentBinding(row.externalRefs,row.id,workflow,referenceSystem)]));
        const ids=[...new Set([...bindings.values()].flatMap(ref=>ref?[ref.id]:[]))], states=new Map<string,KanbanExecutionSession>();let next=0;
        await Promise.all(Array.from({length:Math.min(ids.length,8)},async()=>{while(next<ids.length) {const id=ids[next++];states.set(id,await inspect(board,id));}}));
        return rows.map(row=>{const binding=bindings.get(row.id);return {...row,...(binding?{execution:states.get(binding.id)}: {})};});
    };
    return {
        queryActivity:(boardId:string,query:import('./contracts').KanbanSessionActivityQuery={})=>querySessionItems(core,boardId,query,rows=>project(boardId,rows)),
        async executionSession(boardId:string,itemId:string) {
            const [{item},board,workflow]=await Promise.all([core.item(boardId,itemId),boardMetadata(core,boardId),core.workflow(boardId)]),bindings=executionBindings(item.externalRefs,referenceSystem),last=currentBinding(item.externalRefs,itemId,workflow,referenceSystem);
            return {current:last?await inspect(board,last.id):undefined,history:bindings.map(ref=>({sessionId:ref.id,bindingId:ref.revision,current:ref===last})).reverse()};
        },
        validate:(board:KanbanBoard,command:KanbanCommand|undefined,actor:KanbanActor)=>validateBinding(core,options,board,command,actor,referenceSystem),
    };
}
function createSessionInspector(options:KanbanSessionActivityOptions|undefined,log:Parameters<typeof createKanbanSessionActivity>[2]) {
    const now=options?.now ?? Date.now, cache=new Map<string,KanbanExecutionSession>();
    return async(board:KanbanBoard,sessionId:string):Promise<KanbanExecutionSession>=>{
        const started=now(),key=JSON.stringify([board.id,sessionId]);
        try {
            if(!options) throw new KanbanError('EXECUTION_SESSION_UNAVAILABLE');
            const row=await options.source.inspect(board,sessionId);
            if(row.sessionId!==sessionId) throw new KanbanError('SESSION_ACTIVITY_SCOPE_MISMATCH');
            const stale=row.stale||row.observedAt===undefined||now()-row.observedAt>90000;
            const value:KanbanExecutionSession={sessionId,title:row.title?.slice(0,256),state:row.state,lastActivityAt:row.lastActivityAt,observedAt:row.observedAt,stale,
                recent:!stale&&row.lastActivityAt!==undefined&&row.lastActivityAt<=now()&&now()-row.lastActivityAt<=600000,...(row.code&&/^[A-Z][A-Z0-9_]{0,79}$/.test(row.code)?{code:row.code}:{})};
            if(cache.size>=256) cache.delete(cache.keys().next().value!);cache.set(key,value);return value;
        } catch(error) {
            const candidate=(error as {code?:string})?.code,code=candidate&&/^[A-Z][A-Z0-9_]{0,79}$/.test(candidate)?candidate:'SESSION_ACTIVITY_FAILED';
            try {log({operationId:randomUUID(),sessionId,stage:'session.activity',result:'failure',code,durationMs:now()-started});} catch { /* Observation diagnostics cannot change assignments. */ }
            const prior=['EIO','ETIMEDOUT','ECONNRESET','ECONNREFUSED','SESSION_ACTIVITY_FAILED'].includes(code)?cache.get(key):undefined;
            return {...prior,sessionId,state:prior?.state ?? 'unknown',stale:true,recent:false,code};
        }
    };
}
async function boardMetadata(core: KanbanService, boardId: string): Promise<KanbanBoard> {
    const board=(await core.catalog()).find(board=>board.id===boardId);if(!board) throw new KanbanError('BOARD_NOT_FOUND');
    return {...board,items:[]};
}
async function validateBinding(core: KanbanService, options:KanbanSessionActivityOptions|undefined, board:KanbanBoard, command:KanbanCommand|undefined, actor:KanbanActor, referenceSystem: string): Promise<void> {
    if(command?.type!=='link-reference'||command.reference.system!==referenceSystem) return;
    if(!options||!command.reference.revision) throw new KanbanError('EXECUTION_SESSION_UNAVAILABLE');
    const item=board.items.find(item=>item.id===command.itemId);if(!item) throw new KanbanError('ITEM_NOT_FOUND');
    const key=principalKey(principal(actor)), coordinator=board.members?.some(member=>principalKey(member)===key&&member.roles?.includes('coordinator'));
    if(!coordinator&&item.owner?.principalId!==key&&!(item.owner===undefined&&candidates(board,item).some(candidate=>principalKey(candidate)===key))) throw new KanbanError('EXECUTION_SESSION_ASSIGNMENT_DENIED');
    const active=Object.values((await core.workflow(board.id)).dispatches).find(dispatch=>dispatch.itemId===item.id&&['prepared','running','unknown','succeeded'].includes(dispatch.outcome));
    if(active&&command.reference.revision!==active.id) throw new KanbanError('EXECUTION_SESSION_LOCKED');
    if(active&&executionBindings(item.externalRefs,referenceSystem).some(ref=>ref.revision===active.id&&ref.id!==command.reference.id)) throw new KanbanError('EXECUTION_SESSION_LOCKED');
    if(options.source.authorizeBinding) return options.source.authorizeBinding(board,command.reference.id);
    const state=await options.source.inspect(board,command.reference.id);
    if(state.sessionId!==command.reference.id||state.stale) throw new KanbanError('EXECUTION_SESSION_UNAVAILABLE');
}
