import {DEFAULT_KANBAN_WORK_TYPES, type KanbanBoard, type KanbanCommand, type KanbanExternalReference} from '@itookit/kanban/contracts';
import type {ProjectService} from '@itookit/app-contracts/services';
import {REMOTE_PROJECT_REFERENCE, validateRemoteReferences} from './record-execution';
import {requireValue} from './validation';

type Projects=Pick<ProjectService,'get'>;
const projectRefs=(refs:KanbanExternalReference[]=[])=>(refs.filter(ref=>ref.system===REMOTE_PROJECT_REFERENCE));
/** Project cardinality belongs to NestOS policy; Kanban only stores opaque references. */
export async function validateWorkProjects(projects:Projects,board:KanbanBoard,command:KanbanCommand,required:boolean):Promise<void> {
    if(command.type==='create-item')return validate(projects,board,command.item.externalRefs,command.planning?.kind,command.planning?.parentId,required);
    if(command.type==='publish-plan') {
        for(const definition of command.plan.items) {
            const existing=board.items.find(item=>item.id===definition.id);
            await validate(projects,board,definition.externalRefs??existing?.externalRefs,definition.workType??existing?.planning?.kind,command.plan.rootItemId??existing?.planning?.parentId,required);
        }
    }
    if(command.type==='plan-item') {
        const item=board.items.find(item=>item.id===command.itemId);
        if(item)await validate(projects,board,item.externalRefs,command.planning.kind,command.planning.parentId,required);
    }
    if(command.type==='link-reference'&&command.reference.system===REMOTE_PROJECT_REFERENCE) {
        const item=board.items.find(item=>item.id===command.itemId),refs=projectRefs(item?.externalRefs);
        requireValue(!item?.owner&&(!refs.length||refs.every(ref=>JSON.stringify(ref)===JSON.stringify(command.reference))),'TASK_PROJECT_IMMUTABLE');
        await validate(projects,board,[command.reference],item?.planning?.kind,item?.planning?.parentId,required);
    }
}
async function validate(projects:Projects,board:KanbanBoard,refs:KanbanExternalReference[]|undefined,kind:string|undefined,parentId:string|undefined,required:boolean):Promise<void> {
    const selected=projectRefs(refs),parent=board.items.find(item=>item.id===parentId),inherited=projectRefs(parent?.externalRefs);
    const executable=(board.workTypes??DEFAULT_KANBAN_WORK_TYPES).find(type=>type.id===(kind??board.defaultWorkType??'task'))?.executable;
    if(executable) {
        requireValue(selected.length<=1,'SINGLE_PROJECT_TASK_REQUIRED');
        requireValue(!(required||inherited.length===1)||selected.length===1,'TASK_PROJECT_REQUIRED');
        requireValue(inherited.length!==1||selected[0]?.id===inherited[0].id,'CHILD_PROJECT_MISMATCH');
    }
    if(selected.length)await validateRemoteReferences(projects,{externalRefs:selected});
}
