import {escapeHTML, t, type LocaleKey} from '@itookit/common';
import type {AssistantScanner, ProjectFolder} from '@itookit/app-contracts/services';
import type {SessionSummary} from '@itookit/llm-session/contracts';
import {matchesShortcutQuery, validShortcutTarget, type AssistantShortcut} from './assistant-shortcuts';
export interface AssistantChoices {projects: ProjectFolder[]; sessions: SessionSummary[]; scanners: AssistantScanner[]}
export const assistantLabel = (key: string, values?: Record<string, string | number>) => t(`assistant.${key}` as LocaleKey, values);
const escape = escapeHTML;
export function shortcutEditor(item: AssistantShortcut, choices: AssistantChoices, busy: boolean): string {
    const target = item.target;
    const kind = target.kind === 'resource' && target.workspace === 'chat' && choices.sessions.some(session => session.id === target.resource) ? 'session' : target.kind;
    const options = ['resource', 'directory', 'newSession', 'session', 'scanner'].map(value => `<option value="${value}" ${kind === value ? 'selected' : ''}>${escape(assistantLabel('shortcut.' + value))}</option>`).join('');
    const project = 'projectId' in target ? target.projectId : kind === 'session' && target.kind === 'resource' ? sessionProject(choices.sessions.find(session => session.id === target.resource)!, choices.projects) : '';
    const selected = target.kind === 'scanner' ? JSON.stringify([target.workspaceId, target.scannerId]) : '';
    return `<form class="assistant-menu__form" data-assistant-form><label>${escape(assistantLabel('name'))}<input name="title" maxlength="160" required value="${escape(item.title)}"></label>
        <label>${escape(assistantLabel('keywords'))}<input name="keywords" maxlength="500" value="${escape(item.keywords ?? '')}" placeholder="${escape(assistantLabel('keywordsHelp'))}"></label>
        <label>${escape(assistantLabel('kind'))}<select name="kind">${options}</select></label>
        <label data-assistant-field="project" ${['directory', 'newSession', 'session'].includes(kind) ? '' : 'hidden'}>${escape(assistantLabel('projectSearch'))}<input name="projectSearch" type="search" placeholder="${escape(assistantLabel('filterHelp'))}"></label>
        <label data-assistant-field="project" ${['directory', 'newSession', 'session'].includes(kind) ? '' : 'hidden'}>${escape(assistantLabel('project'))}<select name="project">
        <option value="">${escape(assistantLabel('selectProject'))}</option><option value="@unassigned" ${project === '@unassigned' ? 'selected' : ''}>${escape(assistantLabel('unassigned'))}</option>${choices.projects.map(value => `<option value="${escape(value.project.id)}" ${project === value.project.id ? 'selected' : ''}>${escape(value.displayName || value.name)}</option>`).join('')}</select></label>
        <label data-assistant-field="path" ${kind === 'directory' ? '' : 'hidden'}>${escape(assistantLabel('directory'))}<input name="path" value="${escape(target.kind === 'directory' ? target.path : '')}" placeholder="docs"></label>
        <label data-assistant-field="session" ${kind === 'session' ? '' : 'hidden'}>${escape(assistantLabel('sessionSearch'))}<input name="sessionSearch" type="search" placeholder="${escape(assistantLabel('filterHelp'))}"></label>
        <label data-assistant-field="session" ${kind === 'session' ? '' : 'hidden'}>${escape(assistantLabel('session'))}<select name="session" ${project ? '' : 'disabled'}>${sessionOptions(choices, project, '', target.kind === 'resource' ? target.resource : '')}</select></label>
        <label data-assistant-field="scanner" ${kind === 'scanner' ? '' : 'hidden'}>${escape(assistantLabel('scannerSearch'))}<input name="scannerSearch" type="search" placeholder="${escape(assistantLabel('filterHelp'))}"></label>
        <label data-assistant-field="scanner" ${kind === 'scanner' ? '' : 'hidden'}>${escape(assistantLabel('scanner'))}<select name="scanner"><option value=""></option>${choices.scanners.map(value => `<option value="${escape(JSON.stringify([value.workspaceId, value.id]))}" ${selected === JSON.stringify([value.workspaceId, value.id]) ? 'selected' : ''}>${escape(value.workspaceName + ' · ' + value.name)}</option>`).join('')}</select></label>
        <p data-assistant-field="resource" ${kind === 'resource' ? '' : 'hidden'}>${escape(assistantLabel('currentPageHelp'))}${target.kind === 'resource' ? `<br><small>${escape(target.workspace + ' · ' + (target.resource || '/'))}</small>` : ''}</p><p role="alert" data-assistant-form-error></p>
        <div class="assistant-menu__actions"><button type="submit" ${busy ? 'disabled' : ''}>${escape(t('action.save'))}</button><button type="button" data-assistant-action="cancelEdit" ${busy ? 'disabled' : ''}>${escape(t('action.cancel'))}</button></div></form>`;
}
export function readShortcutForm(form: HTMLFormElement, item: AssistantShortcut, current?: AssistantShortcut['target']): AssistantShortcut {
    const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value.trim();
    const kind = value('kind'), title = value('title'); let target = item.target;
    if (!['resource', 'directory', 'newSession', 'session', 'scanner'].includes(kind)) throw new Error(assistantLabel('selectTarget'));
    if (kind === 'resource' && target.kind !== 'resource') {if (!current) throw new Error(assistantLabel('selectTarget')); target = current;}
    if (kind === 'directory') target = {kind, projectId: value('project'), path: value('path')};
    if (kind === 'newSession') target = {kind, projectId: value('project')};
    if (kind === 'session') {if (!value('project') || !value('session') || (form.elements.namedItem('session') as HTMLSelectElement).disabled) throw new Error(assistantLabel('selectTarget')); target = {kind: 'resource', workspace: 'chat', resource: value('session')};}
    if (kind === 'scanner') {
        let scanner; try {scanner = JSON.parse(value('scanner'));} catch {throw new Error(assistantLabel('selectTarget'));}
        if (!Array.isArray(scanner) || scanner.length !== 2) throw new Error(assistantLabel('selectTarget'));
        target = {kind, workspaceId: scanner[0], scannerId: scanner[1]};
    }
    if (!title || title.length > 160 || value('keywords').length > 500 || !validShortcutTarget(target) || ['directory', 'newSession', 'session'].includes(kind) && (!value('project') || kind !== 'session' && value('project') === '@unassigned')) throw new Error(assistantLabel('invalidShortcut'));
    const project = (form.elements.namedItem('project') as HTMLSelectElement).selectedOptions[0]?.textContent ?? '';
    const scanner = (form.elements.namedItem('scanner') as HTMLSelectElement).selectedOptions[0]?.textContent ?? '';
    const context = kind === 'resource' ? item.context : kind === 'scanner' ? scanner : project;
    return {...item, title, target, keywords: value('keywords'), context: context?.slice(0, 4096)};
}
export function updateShortcutFields(form: HTMLFormElement): void {
    const kind = (form.elements.namedItem('kind') as HTMLSelectElement).value;
    const unassigned = form.querySelector<HTMLOptionElement>('[name=project] option[value="@unassigned"]')!;
    unassigned.hidden = kind !== 'session'; unassigned.disabled = kind !== 'session';
    if (kind !== 'session' && (form.elements.namedItem('project') as HTMLSelectElement).value === '@unassigned') (form.elements.namedItem('project') as HTMLSelectElement).value = '';
    form.querySelectorAll<HTMLElement>('[data-assistant-field]').forEach(field => {
        const name = field.dataset.assistantField!;
        field.hidden = name === 'project' ? !['directory', 'newSession', 'session'].includes(kind) : name === 'path' ? kind !== 'directory' : name !== kind;
    });
}

function sessionProject(session: SessionSummary, projects: ProjectFolder[]): string {
    const folder = session.folder ?? '/';
    return [...projects].sort((a, b) => b.path.length - a.path.length).find(project =>
        folder === project.path || folder.startsWith(project.path.replace(/\/$/, '') + '/'))?.project.id ?? '@unassigned';
}
function sessionOptions(choices: AssistantChoices, project: string, query: string, selected = ''): string {
    const sessions = choices.sessions.filter(session => sessionProject(session, choices.projects) === project && matchesShortcutQuery(query, [session.title]));
    const hint = !project ? 'selectProject' : sessions.length ? 'selectTarget' : 'noSessions';
    return `<option value="">${escape(assistantLabel(hint))}</option>` + sessions.map(session => `<option value="${escape(session.id)}" ${session.id === selected ? 'selected' : ''}>${escape(session.title)}</option>`).join('');
}
export function filterSessionChoices(form: HTMLFormElement, choices: AssistantChoices): void {
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    const select = field('session') as unknown as HTMLSelectElement, selected = select.value;
    select.innerHTML = sessionOptions(choices, field('project').value, field('sessionSearch').value, selected);
    select.disabled = !field('project').value;
}

export function filterTargetChoices(form: HTMLFormElement, choices: AssistantChoices, name: string): void {
    const field = (key: string) => form.elements.namedItem(key) as HTMLInputElement;
    if (name === 'projectSearch') {
        const select = field('project') as unknown as HTMLSelectElement, selected = select.value;
        const matches = choices.projects.filter(project => matchesShortcutQuery(field(name).value, [project.displayName || project.name, project.path]));
        select.innerHTML = `<option value="">${escape(assistantLabel('selectProject'))}</option><option value="@unassigned">${escape(assistantLabel('unassigned'))}</option>` + matches.map(project => `<option value="${escape(project.project.id)}">${escape(project.displayName || project.name)}</option>`).join('');
        select.value = selected; updateShortcutFields(form); filterSessionChoices(form, choices);
    } else if (name === 'scannerSearch') {
        const select = field('scanner') as unknown as HTMLSelectElement, selected = select.value;
        const matches = choices.scanners.filter(scanner => matchesShortcutQuery(field(name).value, [scanner.name, scanner.workspaceName]));
        select.innerHTML = '<option value=""></option>' + matches.map(scanner => `<option value="${escape(JSON.stringify([scanner.workspaceId, scanner.id]))}">${escape(scanner.workspaceName + ' · ' + scanner.name)}</option>`).join('');
        select.value = selected;
    } else filterSessionChoices(form, choices);
}
