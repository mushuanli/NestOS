import type {PersonalKanbanAutomationOptions} from '../kanban/personal-automation';
import {KanbanAutomationJournal} from '../kanban/automation-journal';
import {REMOTE_PROJECT_REFERENCE} from '../kanban/record-execution';
import {requireValue} from '../kanban/validation';
import {developmentPolicy} from './kanban-development-policy';
import {developmentPreparation} from './kanban-development';
import {readSessionFileResult} from '../run/session-file-result';

type Options = Parameters<typeof developmentPreparation>[0];
export function developmentAnalysis(options: Options) {
    const prepare = developmentPreparation(options), journal = new KanbanAutomationJournal(options.fs);
    const prepareAnalysis:NonNullable<PersonalKanbanAutomationOptions['prepareAnalysis']>=async input => {
        const preparation = input.board.automation?.preparation;
        if (preparation?.system !== 'nestos-work-preparation' || preparation.id !== 'git-worktree')
            throw Object.assign(new Error('Planning requires an authorized file workspace'),{code:'SESSION_FILE_WORKSPACE_REQUIRED'});
        const selected = input.item.externalRefs?.filter(ref => ref.system === REMOTE_PROJECT_REFERENCE) ?? [];
        requireValue(selected.length === 1, 'SINGLE_PROJECT_TASK_REQUIRED');
        const folder = await options.projects.get(selected[0].id), view = await options.projects.openWorkspace(folder.path);
        const settings = {...input.board.automation?.preparationOptions, commit: 'changes', modules: ''};
        try {
            const policy = await developmentPolicy(journal, options.fs, view.fs, input.id, settings);
            let target = input.target;
            const source = target.kind === 'agent' ? await options.agents.getAgentRevision?.(target.id, target.version) : undefined;
            requireValue(source?.definition.execution?.kind === 'harness','SESSION_FILE_WORKSPACE_REQUIRED');
            target = await prepare({reportActivity: input.reportActivity, target, preparation, item: input.item, options: settings, stage: 'decision',
                dispatch: {id: input.id, itemId: input.item.id, itemRevision: input.item.revision, planId: input.id, planRevision: 1,
                    principal: input.board.automation!.coordinator, definitionDigest: target.digest, attempt: 1, fence: input.id, preparedAt: Date.now(), outcome: 'prepared', inputs: {}}});
            await journal.update<{projectId:string;path:string}>('analysis-file:'+input.id,old=>old??{projectId:selected[0].id,path:'/workspace/_nestos/worktrees/'+input.id+'/_nestos/kanban/analysis.yaml'});
            const instruction=policy.prompts.files.find(file=>file.name==='decision.md')!.content;
            return {target,instruction:instruction+'\nPublish the planning payload ONLY as YAML at _nestos/kanban/analysis.yaml, wrapped as {schema: nestos.file-result/1, operationId: '+input.id+', payload: <planning object>}. Write a temporary file and atomically rename it. Chat output is informational and is never parsed as a plan.'};
        } finally {await view.dispose();}
    };
    return {prepare:prepareAnalysis,async read(id:string) {
        const binding=await journal.get<{projectId:string;path:string}>('analysis-file:'+id);
        requireValue(binding,'SESSION_FILE_WORKSPACE_REQUIRED');
        const folder=await options.projects.get(binding.projectId),view=await options.projects.openWorkspace(folder.path);
        try{return await readSessionFileResult(view.fs,binding.path,id,journal);}finally{await view.dispose();}
    }};
}
