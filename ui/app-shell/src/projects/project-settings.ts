import {t,createModuleLogger,randomUUID} from '@itookit/common';
import {projectFileSource} from '@itookit/app-contracts';
import type {ProjectFolder, ProjectService} from '@itookit/app-contracts/services';
import {showNameDialog} from '../files/project-dialog';
import {environmentFields, parseEnvironment, projectExecutionSettings} from './project-execution-settings';

/** Every entry captures its own project ID, including overflow and context menus. */
export async function showProjectSettings(projects: ProjectService, id: string, signal: AbortSignal,
    changed: (before: ProjectFolder, after: ProjectFolder) => Promise<void>, beforeSave?: (project: ProjectFolder) => Promise<void>, mountStatus?: (container: HTMLElement, signal: AbortSignal) => void): Promise<void> {
    const project = await projects.get(id), remote = projectFileSource(project, projects.remoteMounts).kind === 'remote';
    const form = await settingsEnvironment(projects,id,signal,remote);
    if (signal.aborted) return;
    const identity = document.createElement('label'); identity.textContent = t('project.id');
    const input = document.createElement('input'); input.readOnly = true; input.value = id; identity.append(input); form.panel.prepend(identity);
    if (project.protected) {const hint = document.createElement('p'); hint.textContent = t('project.localNameHint'); form.panel.prepend(hint);}
    const nameInput = document.createElement('input'); nameInput.id = 'project-settings-name';
    const statusLife = new AbortController();
    const abortStatus = () => statusLife.abort(); signal.addEventListener('abort', abortStatus, {once:true});
    const status = document.createElement('section'); form.panel.prepend(status); mountStatus?.(status,statusLife.signal);
    try {await showNameDialog(`${t('project.settings')} · ${project.displayName ?? project.name}`, t('project.name'), signal, async name => {
        if (!name || /[/\\\0]/.test(name) || ['.','..','@sessions'].includes(name)) throw new Error(t('project.error.name'));
        await beforeSave?.(project);
        await form.save();
        const latest = await projects.get(id);
        if (name !== latest.name) await projects.renameProject(latest.path, `${latest.parentPath ?? ''}/${name}`);
        await changed(project,await projects.get(id));
    }, form.panel, {initialName:project.name,nameInput,confirmLabel:t('action.confirm')});}
    finally {statusLife.abort(); signal.removeEventListener('abort',abortStatus);}
}
async function localEnvironment(projects: ProjectService, id: string) {
    let settings = await projects.localExecutionSettings(id);
    const fields = environmentFields(settings.variables,'project.localEnvironmentHint');
    return {panel:fields.panel,save:async () => {
        const variables = parseEnvironment(fields.text.value);
        if (JSON.stringify(variables) === JSON.stringify(settings.variables)) return;
        await projects.setLocalExecution(id,settings.revision,variables);
        settings = {revision:settings.revision+1,variables};
    }};
}

async function settingsEnvironment(projects: ProjectService,id: string,signal: AbortSignal,remote: boolean) {
    const started = Date.now(), operationId = randomUUID();
    try {return remote ? await projectExecutionSettings(projects.remoteMounts!,id,signal) : await localEnvironment(projects,id);}
    catch (error) {
        if (signal.aborted) throw error;
        const raw = (error ?? {}) as {remoteCode?:string;code?:string};
        const code = raw.remoteCode ?? raw.code;
        const reason = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'ENVIRONMENT_READ_FAILED';
        createModuleLogger('project-settings').warn('project.settings.load',{operationId,projectId:id,stage:'environment-read',result:'failure',code:reason,durationMs:Date.now()-started});
        const panel = document.createElement('p'); panel.textContent = t(remote ? 'project.environmentUnavailable' : 'project.localEnvironmentUnavailable',{reason});
        return {panel,save:async () => {}};
    }
}
