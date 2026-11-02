import type {KanbanActor, KanbanService} from '@itookit/kanban/contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {journalCommand} from './journal-command';

/** Completing a composite never starts another execution or substitutes for child acceptance. */
export async function completeCompositePlans(service:KanbanService,journal:KanbanAutomationJournal,boardId:string,serviceFor:(actor:KanbanActor)=>KanbanService):Promise<void> {
    const workflow=await service.workflow(boardId),roots=new Set(Object.values(workflow.plans).map(plan=>plan.rootItemId).filter((id):id is string=>!!id));
    for(const id of roots) {
        const board=await service.read(boardId),parent=board.items.find(item=>item.id===id);
        if(!board.automation||!parent||parent.owner||parent.blocked||parent.planning?.execution!=='children'||!['backlog','open'].includes(parent.status))continue;
        const ids=new Set(Object.values(workflow.plans).filter(plan=>plan.rootItemId===id).flatMap(plan=>plan.itemIds));
        for(const item of board.items)if(item.planning?.parentId===id)ids.add(item.id);
        const children=await Promise.all([...ids].map(async child=>(await service.item(boardId,child)).item));
        if(!children.length||children.some(item=>item.status!=='completed'))continue;
        await journalCommand(journal,serviceFor(board.automation.coordinator),boardId,'aggregate-complete:'+id,
            {type:'close-plan',itemId:id,resultRef:'kanban:plans:'+JSON.stringify(Object.values(workflow.plans).filter(plan=>plan.rootItemId===id).map(plan=>plan.id))});
    }
}
