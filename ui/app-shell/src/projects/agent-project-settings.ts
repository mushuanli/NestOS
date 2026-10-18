import { t } from '@itookit/common';
import { SettingsAutoSave } from '@itookit/ui-common';
import type { ProjectService } from '@itookit/app-contracts/services';
import { AgentProjectPreferences } from './agent-project-preferences';
import { sessionCreationReason } from './session-creation-policy';

type Project = Awaited<ReturnType<ProjectService['get']>>;
function projectSelect(projects: ProjectService, choices: Project[], allowed: (project: Project) => boolean, projectId?: string, personalFallback = true) {
    const select = document.createElement('select'); select.setAttribute('aria-label', t('agentWorkspace.defaultProject'));
    select.dataset.field = 'agent-default-project';
    const optional = document.createElement('option'); optional.value = '';
    optional.textContent = t(personalFallback ? 'agentWorkspace.personalFallback' : 'agentWorkspace.chooseProject'); select.append(optional);
    for (const project of choices) {
        const option = document.createElement('option'); option.value = project.project.id; option.textContent = project.displayName ?? project.name;
        option.disabled = !allowed(project) || !!sessionCreationReason(projects, project.project.id); select.append(option);
    }
    if (projectId && !choices.some(project => project.project.id === projectId)) {
        const missing = document.createElement('option'); missing.value = projectId; missing.textContent = t('agentWorkspace.missingProject');
        missing.disabled = true; select.append(missing);
    }
    select.value = projectId ?? ''; return select;
}
/** Project policy is a host settings section, separate from portable Agent definitions. */
export async function mountAgentProjectSettings(container: HTMLElement, agentId: string, projects: ProjectService,
    preferences: AgentProjectPreferences, show: (projectId?: string) => Promise<void>,
    allowed: (project: Project) => boolean = () => true, personalFallback = true) {
    const [projectId, choices] = await Promise.all([preferences.read(agentId), projects.list()]);
    container.className = 'agent-project-settings';
    const label = document.createElement('label'); label.textContent = t('agentWorkspace.defaultProject');
    const select = projectSelect(projects, choices, allowed, projectId, personalFallback); label.append(select);
    const hint = document.createElement('p'); hint.textContent = t('agentWorkspace.defaultProjectHint');
    const button = document.createElement('button'); button.type = 'button'; button.textContent = t('agentWorkspace.viewSessions');
    button.dataset.action = 'show-agent-sessions';
    const update = () => {button.disabled = !personalFallback && !select.value;}; update(); select.addEventListener('change', update);
    container.append(label, hint, button);
    for (const type of ['input', 'change']) container.addEventListener(type, event => event.stopPropagation());
    const saves = new SettingsAutoSave(container, async () => {
        if (select.value && !allowed(await projects.get(select.value))) throw new Error(t('agentWorkspace.executorScopeMismatch'));
        await preferences.save(agentId, select.value || undefined);
    });
    button.onclick = () => {button.disabled = true; void saves.flush().then(async saved => {if (saved) await show(select.value || undefined);})
        .catch(error => {hint.textContent = String(error);}).finally(update);};
    return {isDirty: () => saves.isDirty, flush: async () => {if (!await saves.flush()) throw new Error(t('settings.autosave.leaveFailed'));},
        destroy: async () => {if (!await saves.dispose()) throw new Error(t('settings.autosave.leaveFailed')); container.remove();}};
}
