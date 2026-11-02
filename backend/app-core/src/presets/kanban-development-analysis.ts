import type {PersonalKanbanAutomationOptions} from '../kanban/personal-automation';
import {KanbanAutomationJournal} from '../kanban/automation-journal';
import {REMOTE_PROJECT_REFERENCE} from '../kanban/record-execution';
import {requireValue} from '../kanban/validation';
import {developmentPolicy} from './kanban-development-policy';
import {developmentPreparation} from './kanban-development';
import defaults from './kanban-development-prompts.json';

type Options = Parameters<typeof developmentPreparation>[0];
export function developmentAnalysis(options: Options): NonNullable<PersonalKanbanAutomationOptions['prepareAnalysis']> {
    const prepare = developmentPreparation(options), journal = new KanbanAutomationJournal(options.fs);
    return async input => {
        const preparation = input.board.automation?.preparation;
        if (preparation?.system !== 'nestos-work-preparation' || preparation.id !== 'git-worktree')
            return {target: input.target, instruction: defaults['decision.md']};
        const selected = input.item.externalRefs?.filter(ref => ref.system === REMOTE_PROJECT_REFERENCE) ?? [];
        requireValue(selected.length === 1, 'SINGLE_PROJECT_TASK_REQUIRED');
        const folder = await options.projects.get(selected[0].id), view = await options.projects.openWorkspace(folder.path);
        const settings = {...input.board.automation?.preparationOptions, commit: 'changes', modules: ''};
        try {
            const policy = await developmentPolicy(journal, options.fs, view.fs, input.id, settings);
            let target = input.target;
            const source = target.kind === 'agent' ? await options.agents.getAgentRevision?.(target.id, target.version) : undefined;
            if (source?.definition.execution?.kind === 'harness') target = await prepare({reportActivity: input.reportActivity, target, preparation, item: input.item, options: settings, stage: 'decision',
                dispatch: {id: input.id, itemId: input.item.id, itemRevision: input.item.revision, planId: input.id, planRevision: 1,
                    principal: input.board.automation!.coordinator, definitionDigest: target.digest, attempt: 1, fence: input.id, preparedAt: Date.now(), outcome: 'prepared', inputs: {}}});
            return {target, instruction: policy.prompts.files.find(file => file.name === 'decision.md')!.content};
        } finally {await view.dispose();}
    };
}
