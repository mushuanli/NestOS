import {expect,it,vi} from 'vitest';
import type {KanbanBoard,KanbanCommand} from '@itookit/kanban/contracts';
import type {ProjectService} from '@itookit/app-contracts/services';
import {validateWorkProjects} from '../src/kanban/task-projects';
const reference=(id:string)=>({system:'nestos-remote-project',id});
const projects={get:vi.fn(async(id:string)=>({project:{id,source:{kind:id==='local'?'local':'remote'}}}))} as unknown as Pick<ProjectService,'get'>;
const board={id:'board',items:[{id:'parent',planning:{kind:'task'},externalRefs:[reference('one')]}]} as KanbanBoard;
const create=(id:string,parentId?:string):KanbanCommand=>({type:'create-item',item:{id:'child',title:'Child',responsibility:'Work',acceptance:'Checked',externalRefs:[reference(id)]},planning:{kind:'subtask',priority:2,dependencies:[],references:[],parentId}});
it('requires one authorized remote project for executable development work and rejects cross-project children',async()=>{
    await expect(validateWorkProjects(projects,board,create('one','parent'),true)).resolves.toBeUndefined();
    await expect(validateWorkProjects(projects,board,create('two','parent'),true)).rejects.toMatchObject({code:'CHILD_PROJECT_MISMATCH'});
    await expect(validateWorkProjects(projects,board,create('local'),true)).rejects.toMatchObject({code:'REMOTE_PROJECT_REQUIRED'});
    const many=create('one');if(many.type==='create-item')many.item.externalRefs!.push(reference('two'));
    await expect(validateWorkProjects(projects,board,many,true)).rejects.toMatchObject({code:'SINGLE_PROJECT_TASK_REQUIRED'});
    const missing=create('one');if(missing.type==='create-item')missing.item.externalRefs=[];
    await expect(validateWorkProjects(projects,board,missing,true)).rejects.toMatchObject({code:'TASK_PROJECT_REQUIRED'});
    await expect(validateWorkProjects(projects,board,missing,false)).resolves.toBeUndefined();
});
it('prevents rebinding an existing task to another project through references or plan publication',async()=>{
    await expect(validateWorkProjects(projects,board,{type:'link-reference',itemId:'parent',reference:reference('two')},true)).rejects.toMatchObject({code:'TASK_PROJECT_IMMUTABLE'});
    await expect(validateWorkProjects(projects,board,{type:'publish-plan',plan:{schema:'kanban.plan/1',id:'plan',revision:1,sealed:true,rootItemId:'parent',items:[{
        id:'child',title:'Child',responsibility:'Work',acceptance:'Checked',workType:'subtask',externalRefs:[reference('two')],assignee:{kind:'service',id:'worker'},dependsOn:[]}] }},true)).rejects.toMatchObject({code:'CHILD_PROJECT_MISMATCH'});
});
