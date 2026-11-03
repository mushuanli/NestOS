import type {KanbanBoard,KanbanItem} from '@itookit/kanban/contracts';
import type {KanbanAutomationJournal} from './automation-journal';

export interface DecisionContext {sourceBoardId:string;recordId:string;recordRevision:number;runId:string}
/** The host resolves business identity; execution transports receive an opaque file context. */
export async function workContext(journal:KanbanAutomationJournal,board:KanbanBoard,item:KanbanItem) {
    const runId=item.externalRefs?.find(ref=>ref.system==='nestos-decision-run')?.id;
    let decision=runId?await journal.get<DecisionContext>('record-context:'+runId):undefined;
    if(runId&&!decision) {
        const runs=await journal.get<Array<{id:string;sourceBoardId:string;recordId:string;recordRevision:number}>>('record-runs:'+board.id);
        const run=runs?.find(run=>run.id===runId);
        if(run)decision={sourceBoardId:run.sourceBoardId,recordId:run.recordId,recordRevision:run.recordRevision,runId};
    }
    const snapshot = decision ? (await journal.get<Array<{id:string;record:unknown}>>('record-runs:'+decision.sourceBoardId))?.find(run=>run.id===decision.runId)?.record : undefined;
    return {board:{id:board.id,title:board.title,revision:board.revision},decision:decision ? {...decision,...(snapshot ? {snapshot} : {})} : null,
        task:{id:item.id,revision:item.revision,parentId:item.planning?.parentId??null,title:item.title,responsibility:item.responsibility,acceptance:item.acceptance,
            dependencies:item.planning?.dependencies??[]},
        projects:item.externalRefs?.filter(ref=>ref.system==='nestos-remote-project')??[]};
}
