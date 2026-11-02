import {developmentStage} from './kanban-development-log';
import migrations from './kanban-development-prompt-migrations.json';
import {sha256HexSync, t} from '@itookit/common';
import type {IFileSystem} from '@itookit/vfs-core';
import type {KanbanAutomationTarget, KanbanBoard} from '@itookit/kanban/contracts';
import {freezePrompts, readPrompt, failure, type PromptJournal, type PromptBundle} from '../run/prompt-bundle';
import defaults from './kanban-development-prompts.json';

export interface DevelopmentPolicy {
    version: 1; profile: string; commit: 'changes' | 'worktree'; modules: string[]; prompts: PromptBundle;
}
export function developmentCatalog(): KanbanAutomationTarget[] {
    return [{reference: {system: 'nestos-work-preparation', id: 'git-worktree', revision: '1'}, label: t('kanban.gitWorktree'), options: [
        {name: 'profile', label: t('kanban.developmentProfile'), defaultValue: 'development'},
        {name: 'commit', label: t('kanban.commitPolicy'), defaultValue: 'changes', choices: [
            {value: 'changes', label: t('kanban.commitChanges')}, {value: 'worktree', label: t('kanban.commitWorktree')}]},
        {name: 'modules', label: t('kanban.developmentModules'), defaultValue: ''}]}];
}

export async function developmentPolicy(journal: PromptJournal, fs: IFileSystem, project: IFileSystem, id: string,
    options: Record<string, string> = {}): Promise<DevelopmentPolicy> {
    const key = 'development-policy:' + id, old = await journal.get<DevelopmentPolicy>(key); if (old) return old;
    const {profile, commit, modules} = validateDevelopmentOptions(options);
    const prompts = await freezePrompts(journal, 'development-prompts:' + id, () => resolvePrompts(fs, project, profile, id));
    return journal.update<DevelopmentPolicy>(key, previous => previous ?? {version: 1, profile, commit: commit as DevelopmentPolicy['commit'], modules, prompts});
}
export function validateDevelopmentOptions(options: Record<string, string> = {}) {
    const profile = options.profile || 'development', commit = options.commit || 'changes';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile) || !['changes', 'worktree'].includes(commit)
        || Object.keys(options).some(key => !['profile', 'commit', 'modules'].includes(key))) throw failure('DEVELOPMENT_POLICY_INVALID');
    const modules = (options.modules ?? '').split(/[\n,]/).map(value => value.trim()).filter(Boolean);
    if (modules.length > 32 || new Set(modules).size !== modules.length || modules.some(path => !validModulePath(path))) throw failure('MODULE_PATH_INVALID');
    return {profile, commit: commit as DevelopmentPolicy['commit'], modules};
}
export function validModulePath(path: string): boolean {
    return path.length <= 512 && path.split('/').every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part));
}
async function resolvePrompts(fs: IFileSystem, project: IFileSystem, profile: string, operationId:string) {
    const files = [];
    for (const name of ['decision.md', 'task.md'] as const) {
        const global = '/var/lib/kanban/policies/' + profile + '/' + name;
        const local = '/workspace/_nestos/kanban/policies/' + profile + '/' + name;
        const projectOverride = await project.driver.exists(local);
        if (!projectOverride && !await fs.driver.exists(global)) {
            if (profile !== 'development') throw failure('PROMPT_PROFILE_NOT_FOUND');
            try {await fs.driver.createFile({parentPath: global.slice(0, global.lastIndexOf('/')), name, content: defaults[name], recursive: true});}
            catch (error) {if ((error as {code?: string}).code !== 'EEXIST') throw error;}
        }
        const content = projectOverride ? await readPrompt(project,local) : await defaultPrompt(fs,global,name,profile,operationId);
        files.push({name, content, source: projectOverride ? 'project:' + local : 'nestos:' + global, sha256: sha256HexSync(content)});
    }
    return files;
}

export function requiresDevelopmentProject(board:KanbanBoard):boolean {
    return board.automation?.preparation?.system==='nestos-work-preparation'&&board.automation.preparation.id==='git-worktree';
}

async function defaultPrompt(fs:IFileSystem,path:string,name:'decision.md'|'task.md',profile:string,operationId:string):Promise<string> {
    let revision: string | undefined;
    const before=await fs.driver.getNode(path),content=await readPrompt(fs,path,value=>{revision=value;}),after=await fs.driver.getNode(path);
    if(before?.revision!==after?.revision)throw failure('PROMPT_READ_CONFLICT');
    if(profile!=='development'||!migrations[name].includes(sha256HexSync(content)))return content;
    if(before?.type!=='file'||after?.type!=='file'||before.modifiedAt!==after.modifiedAt||before.size!==after.size)throw failure('PROMPT_READ_CONFLICT');
    // Legacy storage cannot replace conditionally; freeze the upgraded default without overwriting authoring files.
    if(revision)await developmentStage(operationId,'prompts.default-upgrade',()=>fs.driver.writeContent(path,defaults[name],{ifRevision:revision}));
    return defaults[name];
}
