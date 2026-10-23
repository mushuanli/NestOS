import { escapeHTML, t } from '@itookit/common';
import { projectFileSource } from '@itookit/app-contracts';
import type { ProjectService } from '@itookit/app-contracts/services';
import { Modal } from '@itookit/ui-common';

export async function showProjectDefaultSettings(projects: ProjectService, signal: AbortSignal, changed: () => Promise<void>): Promise<void> {
    const [catalog, current] = await Promise.all([projects.list(), projects.getDefaultProject()]);
    if (signal.aborted) return;
    const local = catalog.filter(project => projectFileSource(project, projects.remoteMounts).kind === 'local');
    const options = local.map(project => `<option value="${escapeHTML(project.project.id)}" ${project.project.id === current?.project.id ? 'selected' : ''}>${escapeHTML(project.displayName ?? project.name)}</option>`).join('');
    const body = `<div class="settings-form__group"><label class="settings-form__label" for="project-default-select">${t('project.default.label')}</label>
        <select id="project-default-select" class="settings-form__select" ${local.length ? '' : 'disabled'}>${options}</select>
        <p class="settings-form__help">${t(local.length ? 'project.default.help' : 'project.default.noLocal')}</p></div>`;
    await new Promise<void>(resolve => {
        const done = () => { signal.removeEventListener('abort', abort); resolve(); };
        const modal = new Modal(t('project.default.settings'), body, {
            onCancel: done,
            onConfirm: async element => {
                if (signal.aborted) { done(); return; }
                const id = element.querySelector<HTMLSelectElement>('#project-default-select')!.value;
                if (id) { await projects.setDefaultProject(id); await changed(); }
                done();
            },
        });
        const abort = () => { modal.hide(); done(); };
        signal.addEventListener('abort', abort, { once: true });
        modal.show();
    });
}
