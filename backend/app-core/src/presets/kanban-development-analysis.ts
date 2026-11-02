import {DirectorySubscriptions} from '../run/directory-subscriptions';
import type {PersonalKanbanAutomationOptions} from '../kanban/personal-automation';
import {KanbanAutomationJournal} from '../kanban/automation-journal';
import {requireValue} from '../kanban/validation';
import {developmentPreparation,type DevelopmentWorkspaceRecord} from './kanban-development';
import planning from './kanban-planning.json';
import {readSessionFileResult,sessionFileResultPrompt} from '../run/session-file-result';

type Options = Parameters<typeof developmentPreparation>[0];
export function developmentAnalysis(options: Options,wake:()=>void=()=>{}) {
    const prepare = developmentPreparation(options), journal = new KanbanAutomationJournal(options.fs),watches=new DirectorySubscriptions();
    const prepareAnalysis:NonNullable<PersonalKanbanAutomationOptions['prepareAnalysis']>=async input => {
        const preparation=input.board.automation?.preparation;
        requireValue(preparation,'SESSION_FILE_WORKSPACE_REQUIRED');
        const target=await prepare({context:input.context,reportActivity:input.reportActivity,target:input.target,preparation,item:input.item,
            options:{...input.board.automation?.preparationOptions,commit:'changes',modules:''},stage:'decision',
            dispatch:{id:input.id,itemId:input.item.id,itemRevision:input.item.revision,planId:input.id,planRevision:1,
                principal:input.board.automation!.coordinator,definitionDigest:input.target.digest,attempt:1,fence:input.id,
                preparedAt:Date.now(),outcome:'prepared',inputs:{}}});
        const workspace=await journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+input.id);
        requireValue(workspace,'SESSION_FILE_WORKSPACE_REQUIRED');
        await watch(input.id,workspace.projectId);
        const instruction=workspace.policy.prompts.files.find(file=>file.name==='decision.md')!.content;
        return {target,instruction:instruction+'\n'+planning.instruction+'\n'+sessionFileResultPrompt('_nestos/kanban/analysis.yaml',input.id)};
    };
    async function watch(id:string,projectId:string) {
        await watches.ensure(id,async()=>{
            const client=await options.remote.projectHarness(projectId);
            try {const stop=client.subscribeDirectoryPath?.('_nestos/worktrees/'+id+'/_nestos/kanban',wake);
                return async()=>{stop?.();await client.close();};}
            catch(error){await client.close();throw error;}
        });
    }
    return {prepare:prepareAnalysis,dispose:()=>watches.dispose(),async read(id:string) {
        const workspace=await journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+id);
        requireValue(workspace,'SESSION_FILE_WORKSPACE_REQUIRED');
        const folder=await options.projects.get(workspace.projectId),view=await options.projects.openWorkspace(folder.path);
        try{
            await watch(id,workspace.projectId);
            const result=await readSessionFileResult(view.fs,workspace.directory+'/_nestos/kanban/analysis.yaml',id,journal);
            if(result!==undefined)await watches.close(id);
            return result;
        }
        finally{await view.dispose();}
    }};
}
