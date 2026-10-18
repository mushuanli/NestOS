import { t } from '@itookit/common';
import type { SessionDraftControls, SessionDraftPreferences } from '@itookit/ui-common';

/** Switching scope opens its independent saved draft after the current one is flushed. */
export function mountDraftProjectScope(container: HTMLElement, scope: NonNullable<SessionDraftControls['scope']>,
    flush: () => Promise<void>, preferences: () => SessionDraftPreferences | undefined) {
    let closed = false, pending = false, loaded = false, blocked = false;
    const row = document.createElement('label'); row.className = 'llm-draft-scope';
    const select = document.createElement('select'); select.setAttribute('aria-label', t('agentWorkspace.project'));
    const current = document.createElement('option'); current.value = scope.id; current.textContent = scope.label;
    select.append(current); select.value = scope.id; select.title = t('agentWorkspace.switchDraftHint');
    const status = document.createElement('span'); status.setAttribute('role', 'status'); row.append(select, status);
    (container.querySelector('.llm-input__execution-picker') ?? container).before(row);
    const load = async () => {
        if (pending || closed) return;
        pending = true; select.disabled = true;
        try {
            const choices = await scope.choices(); if (closed) return;
            select.replaceChildren(...choices.map(item => {const option = document.createElement('option'); option.value = item.id;
                option.textContent = item.label; option.disabled = !!item.disabled; return option;}));
            select.value = scope.id; loaded = true;
        } catch (error) {if (!closed) status.textContent = String(error);}
        finally {pending = false; if (!closed) select.disabled = blocked;}
    };
    select.onfocus = () => {if (!loaded) void load();};
    select.onchange = () => {
        if (pending || closed || select.value === scope.id) return;
        const captured = preferences();
        const next = select.value; pending = true; select.disabled = true;
        void flush().then(() => {if (!closed) return scope.select(next, captured?.agentId, captured);}).catch(error => {if (!closed) status.textContent = String(error);})
            .finally(() => {pending = false; if (!closed) {select.value = scope.id; select.disabled = false;}});
    };
    void load();
    return {refresh: load, setDisabled(disabled: boolean) {blocked = disabled; select.disabled = disabled || pending;}, destroy() {closed = true; row.remove();}};
}
