import type {SessionDraftControls} from '../../contracts';
import {createModuleLogger, randomUUID, t} from '@itookit/common';


const log = createModuleLogger('draft-header');
export function mountDraftHeader(root: HTMLElement, options: {controls: SessionDraftControls; title(): string; busy(): boolean;
    changeTitle(value: string): void; changeProject(id: string): Promise<void>; report(error: unknown): void}) {
    const lifetime = new AbortController(), label = document.createElement('div'); label.className = 'llm-draft-header';
    const project = document.createElement('select'), title = document.createElement('input');
    project.className = 'llm-draft-header__project'; project.setAttribute('aria-label', t('project.draftProject'));
    title.className = 'llm-draft-header__title'; title.type = 'text'; title.maxLength = 200;
    title.setAttribute('aria-label', t('project.draftTitle')); title.placeholder = t('project.draftTitlePlaceholder');
    label.append(project, title); root.dataset.projectDraft = ''; root.append(label);
    let switching = false;
    const update = () => {if (title.value !== options.title()) title.value = options.title();
        title.disabled = switching || options.busy(); project.disabled = switching || options.busy() || !options.controls.scope?.move;};
    const scope = options.controls.scope;
    const initial = document.createElement('option'); initial.value = scope?.id ?? ''; initial.textContent = scope?.label ?? '';
    project.append(initial); project.hidden = !scope; project.disabled = !scope?.move;
    if (scope) void scope.choices().then(choices => {
        if (lifetime.signal.aborted) return;
        project.replaceChildren(...choices.map(choice => {const option = document.createElement('option');
            option.value = choice.id; option.textContent = choice.label; option.disabled = !!choice.disabled; return option;})); project.value = scope.id;
    }).catch(error => {if (!lifetime.signal.aborted) options.report(error);});
    title.oninput = () => {if (!options.busy() && !switching) options.changeTitle(title.value); else update();};
    project.onchange = () => {if (options.busy() || switching) {if (scope) project.value = scope.id; update(); return;} if (project.value === scope?.id) return;
        const id = project.value, operationId = randomUUID(), started = Date.now(); switching = true; update();
        void options.changeProject(id).then(() => {log.info('draft.project', {operationId, stage: 'complete', result: 'success', durationMs: Date.now() - started});})
            .catch(error => {if (scope) project.value = scope.id; options.report(error); log.warn('draft.project', {operationId, stage: 'move', result: 'failure',
                code: (error as {code?: string})?.code ?? 'DRAFT_PROJECT_SWITCH_FAILED', durationMs: Date.now() - started});})
            .finally(() => {switching = false; if (!lifetime.signal.aborted) update();});};
    update(); return {label, update, destroy: () => {lifetime.abort(); label.remove(); if (!root.querySelector('.llm-draft-header')) delete root.dataset.projectDraft;}};
}
