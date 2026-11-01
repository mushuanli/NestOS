import type {UserEventService} from '../events/service';

/** One notification per failure episode; journal state and fact append commit atomically. */
export async function reportKanbanHealth(events: UserEventService, error?: unknown): Promise<void> {
    const key='kanban:personal:health';
    await events.journal.transaction(async tx=>{
        const raw=await tx.getState(key), previous=raw?JSON.parse(raw) as {failed:boolean;episode:number}: {failed:false,episode:0};
        if(!error) {if(previous.failed) await tx.setState(key,JSON.stringify({...previous,failed:false}));return;}
        if(previous.failed) return;
        const code=kanbanFailureCode(error);
        const episode=previous.episode+1, operationId=`kanban:recovery:${episode}`;
        await tx.append(operationId,{type:`kanban.runtime.${code}`,resourceId:'kanban:personal',operationId,notification:'error'},Date.now());
        await tx.setState(key,JSON.stringify({failed:true,episode}));
    });
}
export function kanbanFailureCode(error: unknown): string {
    const cause=error instanceof AggregateError?error.errors[0]:error, candidate=(cause as {code?:unknown})?.code;
    return typeof candidate==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(candidate)?candidate:'KANBAN_RECONCILE_FAILED';
}
