import { escapeAttr, t } from '@itookit/common';
import type { LLMProvider } from '@itookit/driver-llm/contracts';

export function textTestModels(provider: LLMProvider) {
    return provider.models.filter(model => model.category === 'chat' || model.category === undefined && model.capabilitiesKnown !== false);
}

export function renderTextProbe(provider: LLMProvider): string {
    const models = textTestModels(provider);
    return `<label class="settings-form__label">${t('provider.test.textModel')}</label>
        <select class="settings-form__select" name="connectionTestModel" ${models.length ? '' : 'disabled'}>
            ${models.length ? models.map(model => `<option value="${escapeAttr(model.id)}" ${provider.connectionTestModel === model.id ? 'selected' : ''}>${escapeAttr(model.name)} · ${escapeAttr(model.id)}</option>`).join('')
        : `<option value="">${t('provider.test.noTextModel')}</option>`}</select>
        <small class="settings-form__help">${t('provider.test.textOnly')}</small>`;
}

/** Tabs only hide panels; editing state and validation stay in the original DOM. */
export function mountProviderTabs(form: HTMLFormElement): void {
    form.closest('.settings-page')?.classList.add('provider-settings-page');
    const nav = document.createElement('nav'); nav.className = 'provider-settings__tabs';
    nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', t('provider.tabs.label'));
    const panels = [...form.querySelectorAll<HTMLElement>('[data-provider-panel]')];
    for (const panel of panels) {
        const key = panel.dataset.providerPanel as 'overview' | 'models' | 'connections' | 'advanced';
        const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'tab');
        button.textContent = t(`provider.tabs.${key}`); button.dataset.providerTab = key;
        button.id = `provider-tab-${key}`; panel.id = `provider-panel-${key}`;
        button.setAttribute('aria-controls', panel.id); panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
        button.onclick = () => selectPanel(nav, panels, key);
        button.onkeydown = event => moveTab(event, nav);
        nav.append(button);
    }
    form.prepend(nav); selectPanel(nav, panels, 'overview');
    form.addEventListener('invalid', event => {
        const panel = (event.target as Element).closest<HTMLElement>('[data-provider-panel]');
        if (panel) selectPanel(nav, panels, panel.dataset.providerPanel!);
        let parent = (event.target as Element).parentElement;
        while (parent && parent !== form) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
    }, true);
}

function selectPanel(nav: HTMLElement, panels: HTMLElement[], key: string): void {
    for (const panel of panels) panel.hidden = panel.dataset.providerPanel !== key;
    for (const button of nav.querySelectorAll<HTMLButtonElement>('button')) {
        const selected = button.dataset.providerTab === key;
        button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    }
}

function moveTab(event: KeyboardEvent, nav: HTMLElement): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...nav.querySelectorAll<HTMLButtonElement>('button')], index = buttons.indexOf(event.currentTarget as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[next].click(); buttons[next].focus();
}
