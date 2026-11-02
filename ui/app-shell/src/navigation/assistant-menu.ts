import {ASSISTANT_ADD_EVENT, type ShortcutRequest} from './assistant-actions';
import {setTimePresentation, navigationItem} from '@itookit/ui-common-adapter';
import {ACTION_ICONS, createModuleLogger, escapeHTML, randomUUID, t} from '@itookit/common';
import type {ApplicationBackend, ApplicationServices, AssistantEvent, AssistantOverview} from '@itookit/app-contracts/services';
import type {VfsJsonStore} from '../persistence/vfs-json-store';
import {assistantLabel as label, shortcutEditor, readShortcutForm, updateShortcutFields, filterTargetChoices, filterSessionChoices, type AssistantChoices} from './assistant-editor';
import {matchesShortcutQuery, shortcutSearchValues, validShortcutTarget, ASSISTANT_MENU_DOCUMENT, emptyAssistantState, readAssistantState, shortcutNavigation, type AssistantShortcut, type AssistantMenuState} from './assistant-shortcuts';
import './assistant-menu.css';
const escape = escapeHTML, log = createModuleLogger('assistant-menu');
interface Options {
    services: ApplicationServices; backend: ApplicationBackend; documents: Pick<VfsJsonStore, 'read' | 'write' | 'flush'>;
    current(): {workspace: string; resource: string; title: string}; navigate(target: {target: string; resourceId?: string}): Promise<void>;
    home?(): Promise<void>; signal: AbortSignal;
}
export function installAssistantMenu(options: Options): () => void {const menu = new AssistantMenu(options); menu.install(); return () => menu.close();}

class AssistantMenu {
    private state: AssistantMenuState = emptyAssistantState();
    private overview: AssistantOverview = {events: [], scanners: [], unavailable: []};
    private readonly dialog = document.createElement('dialog');
    private readonly body = document.createElement('div');
    private readonly buttons: HTMLButtonElement[] = [];
    private readonly releases: Array<() => void> = [];
    private readonly lifetime = new AbortController();
    private timer?: ReturnType<typeof setTimeout>;
    private reading = false; private dirty = false; private closed = false; private busy = false; private ready = false; private hasOverview = false; private stale = false;
    private storageError = ''; private error = ''; private all = false; private managing = false;
    private editing?: AssistantShortcut; private choices: AssistantChoices = {projects: [], sessions: [], scanners: []};
    private origin?: HTMLElement; private query = '';
    private stateLoaded?: Promise<void>;
    private readonly selectedEvents = new Map<string, string>();
    private readonly missingIcons = new Set<string>();
    constructor(private readonly options: Options) {}
    install(): void {
        const signal = this.lifetime.signal;
        this.mountLaunchers(); this.dialog.className = 'assistant-menu'; this.dialog.setAttribute('aria-label', label('title'));
        this.body.className = 'assistant-menu__body'; this.dialog.append(this.body); document.body.append(this.dialog);
        this.dialog.addEventListener('click', event => {if (event.target === this.dialog) this.dialog.close();}, {signal});
        this.body.addEventListener('click', event => this.click(event), {signal});
        this.body.addEventListener('submit', event => {event.preventDefault(); void this.saveShortcut(event.target as HTMLFormElement);}, {signal});
        this.body.addEventListener('change', event => {this.selectEvents(event); this.formChange(event);}, {signal});
        this.body.addEventListener('input', event => this.filter(event), {signal});
        this.body.addEventListener('keydown', event => this.searchKey(event), {signal});
        document.addEventListener(ASSISTANT_ADD_EVENT, event => {void this.addFromNavigation((event as CustomEvent<ShortcutRequest>).detail);}, {signal});
        this.dialog.addEventListener('close', () => {this.buttons.forEach(button => button.setAttribute('aria-expanded', 'false')); this.editing = undefined; this.origin?.focus();}, {signal});
        document.addEventListener('visibilitychange', () => {if (!document.hidden) this.schedule();}, {signal});
        this.options.signal.addEventListener('abort', () => this.close(), {once: true});
        const services = this.options.services;
        this.releases.push(services.sessionRepository.subscribe?.(() => this.schedule()) ?? (() => {}),
            services.kernel?.kernel?.onChanged?.(event => {if (event.reason === 'structure') this.schedule();}) ?? (() => {}),
            services.digitalTwin?.onChange(() => this.schedule()) ?? (() => {}));
        if (!this.options.backend.assistantOverview) {this.stale = true; this.error = label('eventsUnavailable');}
        this.stateLoaded = this.loadState(); this.schedule();
    }
    private mountLaunchers(): void {
        const brand = document.querySelector<HTMLElement>('.app-sidebar__brand');
        if (brand) {
            const previous = [...brand.childNodes], button = this.launcher(false);
            button.dataset.brandLabel = brand.getAttribute('aria-label') || brand.textContent?.trim() || 'NestOS';
            const count = button.querySelector<HTMLElement>('[data-assistant-count]')!; count.hidden = true;
            button.replaceChildren(...previous, count); brand.replaceChildren(button);
            this.releases.push(() => brand.replaceChildren(...previous));
        }
        const list = document.querySelector('.app-sidebar .main-nav-list');
        if (list) {const item = document.createElement('li'); item.className = 'app-nav-item--assistant'; item.append(this.launcher(true)); list.prepend(item); this.releases.push(() => item.remove());}
    }
    private launcher(mobile: boolean): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'assistant-launcher' + (mobile ? ' app-nav-btn' : ''); if (mobile) navigationItem(button); button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false');
        button.innerHTML = `<span class="assistant-launcher__icon">${this.icon('assistant', 'nav')}<span class="assistant-launcher__count" data-assistant-count>…</span></span><span class="assistant-launcher__label">${escape(label('nav'))}</span>`;
        button.addEventListener('click', () => {
            this.origin = button; this.all = false; this.render(); if (!this.dialog.open) this.dialog.showModal(); button.setAttribute('aria-expanded', 'true'); this.schedule();
        }, {signal: this.lifetime.signal}); this.buttons.push(button); return button;
    }
    private async loadState(): Promise<void> {
        const started = performance.now();
        try {this.state = readAssistantState(await this.options.documents.read(ASSISTANT_MENU_DOCUMENT)); this.storageError = '';}
        catch {this.storageError = label('settingsUnavailable'); this.report('settings-read', 'ASSISTANT_SETTINGS_UNAVAILABLE', undefined, performance.now() - started);}
        if (this.closed) return; this.ready = true; this.updateCount(); this.render();
    }
    private schedule(): void {
        if (this.closed || document.hidden || !this.options.backend.assistantOverview) return;
        this.dirty = true;
        if (this.timer || this.reading) return;
        this.timer = setTimeout(() => {this.timer = undefined; void this.refresh();}, 400);
    }
    private async refresh(): Promise<void> {
        if (this.closed || this.reading || document.hidden) return;
        this.reading = true; this.dirty = false; const started = performance.now();
        try {
            const result = await this.options.backend.assistantOverview!(); if (this.closed) return;
            const retained = this.overview.events.filter(item => result.unavailable.includes(item.source));
            this.overview = {...result, events: [...result.events.filter(item => !result.unavailable.includes(item.source)), ...retained]
                .sort((a, b) => a.priority - b.priority || b.at - a.at || a.id.localeCompare(b.id))};
            this.hasOverview = true; this.stale = result.unavailable.length > 0;
            this.error = this.stale ? label('eventsUnavailable') : '';
        } catch {this.stale = true; this.error = label('eventsUnavailable'); this.report('events-read', 'ASSISTANT_EVENTS_UNAVAILABLE', undefined, performance.now() - started);}
        finally {this.reading = false; if (!this.closed) {this.updateCount(); if (!this.editing && !this.busy) this.render(); if (this.dirty) this.schedule();}}
    }
    private events(): AssistantEvent[] {return this.overview.events.filter(item => item.requiresAction || this.state.seen[item.id] !== item.revision);}
    private updateCount(): void {
        const count = this.events().length;
        for (const button of this.buttons) {
            button.querySelector('[data-assistant-count]')!.textContent = !this.hasOverview && !this.stale ? '…' : this.stale ? count ? `${Math.min(count, 99)}+` : '?' : count > 99 ? '99+' : String(count);
            button.classList.toggle('assistant-launcher--attention', count > 0);
            button.title = (button.dataset.brandLabel ? button.dataset.brandLabel + ' · ' : '') + label(this.stale ? 'eventsStale' : this.hasOverview ? 'eventCount' : 'loading', {count}); button.setAttribute('aria-label', button.title);
        }
    }
    private render(): void {
        if (this.closed || this.editing && this.body.querySelector('form')) return;
        this.pruneEventSelection();
        const events = this.events(), shown = this.all ? events : events.slice(0, 3), disabled = this.busy ? 'disabled' : '';
        const scroll = this.body.scrollTop, searching = document.activeElement === this.body.querySelector('[data-assistant-search]');
        const caret = searching ? (document.activeElement as HTMLInputElement).selectionStart : null;
        this.body.innerHTML = `<header class="assistant-menu__header"><h2>${escape(label('title'))}</h2><button type="button" data-assistant-action="close" ${disabled}>${escape(t('action.close'))}</button></header>
            <p class="assistant-menu__error" role="alert">${escape(this.storageError || this.error)}</p>
            <section><div class="assistant-menu__heading"><h3>${escape(label('events'))}</h3><span>${escape(label('eventCount', {count: events.length}))}</span></div>
            ${events.some(item => !item.requiresAction) ? `<div class="assistant-menu__actions"><label class="assistant-menu__selection"><input type="checkbox" data-assistant-select-all ${disabled}>${escape(label('selectShownEvents'))}</label><button type="button" data-assistant-action="clearSelected">${escape(label('clearSelected', {count: this.selectedEvents.size}))}</button></div>` : ''}
            ${shown.length ? shown.map(item => this.eventRow(item)).join('') : `<p class="assistant-menu__empty">${escape(label(this.reading || !this.ready ? 'loading' : 'noEvents'))}</p>`}
            ${events.length > 3 ? `<button type="button" data-assistant-action="all">${escape(this.all ? label('collapse') : label('allEvents', {count: events.length - 3}))}</button>` : ''}</section>
            <section><div class="assistant-menu__heading"><h3>${escape(label('shortcuts'))}</h3><div class="assistant-menu__actions"><button type="button" data-assistant-action="add" ${!this.ready || this.storageError || this.busy ? 'disabled' : ''}>${escape(label('add'))}</button>
            <button type="button" data-assistant-action="manage" ${disabled}>${escape(label(this.managing ? 'done' : 'manage'))}</button></div></div>
            <label class="assistant-menu__search">${escape(label('filter'))}<input type="search" data-assistant-search maxlength="500" value="${escape(this.query)}" placeholder="${escape(label('filterHelp'))}"></label>
            <p class="assistant-menu__empty" data-assistant-filter-count role="status"></p><div data-assistant-shortcut-list></div>
            ${this.editing ? shortcutEditor(this.editing, this.choices, this.busy) : ''}</section>
            <footer class="assistant-menu__actions"><button type="button" data-assistant-action="refresh" ${disabled}>${escape(t('action.refresh'))}</button>${this.options.home ? `<button type="button" data-assistant-action="home">${escape(label('home'))}</button>` : ''}</footer>`;
        this.body.querySelectorAll<HTMLTimeElement>('[data-assistant-time]').forEach(time => setTimePresentation(time, Number(time.dataset.assistantTime), ''));
        this.updateEventSelection(); this.renderShortcuts();
        const form = this.body.querySelector<HTMLFormElement>('form'); if (form) updateShortcutFields(form);
        this.body.scrollTop = scroll;
        if (searching) {const search = this.body.querySelector<HTMLInputElement>('[data-assistant-search]')!; search.focus({preventScroll: true}); if (caret !== null) search.setSelectionRange(caret, caret);}
    }
    private renderShortcuts(): void {
        const list = this.body.querySelector('[data-assistant-shortcut-list]'); if (!list) return;
        const items = this.state.shortcuts.filter(item => matchesShortcutQuery(this.query, shortcutSearchValues(item)));
        list.innerHTML = items.length ? items.map(item => this.shortcutRow(item)).join('') : `<p class="assistant-menu__empty">${escape(label(this.state.shortcuts.length ? 'noMatches' : 'noShortcuts'))}</p>`;
        this.body.querySelector('[data-assistant-filter-count]')!.textContent = this.query.trim() ? label('filterCount', {count: items.length, total: this.state.shortcuts.length}) : '';
    }
    private filter(event: Event): void {
        const input = event.target as HTMLInputElement;
        if (input.hasAttribute('data-assistant-search')) {this.query = input.value; this.renderShortcuts(); return;}
        const form = input.closest('form');
        if (form && ['sessionSearch', 'projectSearch', 'scannerSearch'].includes(input.name)) filterTargetChoices(form, this.choices, input.name);
    }
    private searchKey(event: KeyboardEvent): void {
        const input = event.target as HTMLInputElement;
        if (!input.hasAttribute('data-assistant-search') || event.key !== 'Escape' || !input.value) return;
        event.preventDefault(); event.stopPropagation(); input.value = ''; this.query = ''; this.renderShortcuts();
    }
    private formChange(event: Event): void {
        const input = event.target as HTMLInputElement, form = input.closest('form'); if (!form) return;
        if (input.name === 'kind') updateShortcutFields(form);
        if (input.name === 'kind' || input.name === 'project') filterSessionChoices(form, this.choices);
    }
    private async addFromNavigation(request: ShortcutRequest): Promise<void> {
        if (!request || typeof request.title !== 'string' || !validShortcutTarget(request.target)) return;
        await this.stateLoaded; if (this.closed) return;
        request = {...request, title: request.title.slice(0, 160), context: request.context?.slice(0, 4096)};
        this.origin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        this.render(); if (!this.dialog.open) this.dialog.showModal();
        this.buttons.forEach(button => button.setAttribute('aria-expanded', 'true'));
        const existing = this.state.shortcuts.find(item => JSON.stringify(item.target) === JSON.stringify(request.target));
        await this.edit(existing?.id, request);
        this.body.querySelector<HTMLInputElement>('[name=title]')?.focus();
    }
    private eventRow(item: AssistantEvent): string {
        return `<article class="assistant-menu__event">${item.requiresAction ? '' : `<label class="assistant-menu__selection"><input type="checkbox" data-assistant-select="${escape(item.id)}" aria-label="${escape(label('selectEvent', {title: item.title}))}" ${this.selectedEvents.get(item.id) === item.revision ? 'checked' : ''} ${this.busy || !this.ready || this.storageError ? 'disabled' : ''}></label>`}<button type="button" data-assistant-event="${escape(item.id)}"><strong>${escape(label('event.' + item.kind))}</strong><span>${escape(item.title)}</span><time data-assistant-time="${item.at}"></time></button>
            ${item.requiresAction ? '' : `<button type="button" data-assistant-read="${escape(item.id)}" aria-label="${escape(label('markRead'))}">${this.icon('markRead', 'markRead')}</button>`}</article>`;
    }
    private pruneEventSelection(): void {
        const events = new Map(this.events().filter(item => !item.requiresAction).map(item => [item.id, item.revision]));
        for (const [id, revision] of this.selectedEvents) if (events.get(id) !== revision) this.selectedEvents.delete(id);
    }
    private updateEventSelection(): void {
        const inputs = [...this.body.querySelectorAll<HTMLInputElement>('[data-assistant-select]')];
        const selected = inputs.filter(input => input.checked).length;
        const all = this.body.querySelector<HTMLInputElement>('[data-assistant-select-all]');
        if (all) {all.checked = inputs.length > 0 && selected === inputs.length; all.indeterminate = selected > 0 && selected < inputs.length;
            all.disabled = !inputs.length || this.busy || !this.ready || !!this.storageError;}
        const clear = this.body.querySelector<HTMLButtonElement>('[data-assistant-action=clearSelected]');
        if (clear) {clear.textContent = label('clearSelected', {count: this.selectedEvents.size});
            clear.disabled = !this.selectedEvents.size || this.busy || !this.ready || !!this.storageError;}
    }
    private selectEvents(event: Event): void {
        const input = event.target as HTMLInputElement;
        if (this.busy || !this.ready || this.storageError) return;
        const all = input.hasAttribute('data-assistant-select-all');
        if (!all && !input.hasAttribute('data-assistant-select')) return;
        const inputs = all ? [...this.body.querySelectorAll<HTMLInputElement>('[data-assistant-select]')] : [input];
        for (const checkbox of inputs) {
            const item = this.events().find(item => item.id === checkbox.dataset.assistantSelect && !item.requiresAction);
            if (!item) continue;
            checkbox.checked = input.checked;
            if (input.checked) this.selectedEvents.set(item.id, item.revision); else this.selectedEvents.delete(item.id);
        }
        this.updateEventSelection();
    }
    private async clearSelectedEvents(): Promise<void> {
        const items = this.events().filter(item => !item.requiresAction && this.selectedEvents.get(item.id) === item.revision);
        if (!items.length) return;
        await this.markEventsRead(items);
    }
    private shortcutRow(item: AssistantShortcut): string {
        return `<div class="assistant-menu__shortcut"><button type="button" data-assistant-shortcut="${escape(item.id)}"><span>${escape(item.title)}</span>${item.context ? `<small>${escape(item.context)}</small>` : ''}</button>${this.managing ? `<div class="assistant-menu__actions">
            ${['edit', 'up', 'down', 'remove'].map(action => `<button type="button" data-assistant-action="${action}" data-assistant-id="${escape(item.id)}" ${this.busy ? 'disabled' : ''}>${escape(label(action))}</button>`).join('')}</div>` : ''}</div>`;
    }
    private click(event: MouseEvent): void {
        const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button || this.busy || this.closed) return;
        if (button.dataset.assistantEvent) {const item = this.overview.events.find(item => item.id === button.dataset.assistantEvent); if (item) void this.openEvent(item); return;}
        if (button.dataset.assistantRead) {const item = this.overview.events.find(item => item.id === button.dataset.assistantRead); if (item) void this.markRead(item); return;}
        if (button.dataset.assistantShortcut) {const item = this.state.shortcuts.find(item => item.id === button.dataset.assistantShortcut); if (item) void this.openShortcut(item); return;}
        const action = button.dataset.assistantAction, id = button.dataset.assistantId;
        if (action === 'close') this.dialog.close();
        if (action === 'clearSelected') void this.clearSelectedEvents();
        if (action === 'all') {this.all = !this.all; this.render();}
        if (action === 'refresh') {this.schedule(); if (this.storageError) void this.loadState();}
        if (action === 'home') void this.navigate(this.options.home!);
        if (action === 'manage') {this.managing = !this.managing; this.render();}
        if (action === 'add' || action === 'edit') void this.edit(id);
        if (action === 'cancelEdit') {this.editing = undefined; this.render();}
        if (id && ['up', 'down', 'remove'].includes(action ?? '')) void this.modify(id, action!);
    }
    private async edit(id?: string, requested?: ShortcutRequest): Promise<void> {
        if (this.storageError || this.editing || this.busy) return;
        if (!id && this.state.shortcuts.length >= 50) {this.error = label('shortcutLimit'); this.render(); return;}
        this.busy = true; const started = performance.now();
        try {
            const repository = this.options.services.sessionRepository;
            const [projects, sessions] = await Promise.all([this.options.services.projects.list(), repository.listSummaries?.() ?? repository.list()]);
            if (this.closed) return;
            this.choices = {projects, sessions: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt), scanners: this.overview.scanners};
            const current = this.options.current(); this.editing = this.state.shortcuts.find(item => item.id === id) ?? {id: randomUUID(), ...(requested ?? {title: current.title, target: {kind: 'resource' as const, workspace: current.workspace, resource: current.resource}})};
        } catch {this.error = label('targetsUnavailable'); this.report('targets-read', 'ASSISTANT_TARGETS_UNAVAILABLE', undefined, performance.now() - started);}
        finally {this.busy = false; this.render();}
    }
    private async saveShortcut(form: HTMLFormElement): Promise<void> {
        if (!this.editing || this.busy) return;
        try {
            const current = this.options.current(), item = readShortcutForm(form, this.editing, {kind: 'resource', workspace: current.workspace, resource: current.resource});
            const shortcuts = this.state.shortcuts.some(value => value.id === item.id) ? this.state.shortcuts.map(value => value.id === item.id ? item : value) : [...this.state.shortcuts, item];
            form.inert = true;
            await this.persist({...this.state, shortcuts}); this.editing = undefined; this.error = ''; this.query = ''; this.render();
        } catch (error) {if (error instanceof Error && error.message !== label('saveFailed') && error.message !== this.storageError) this.report('shortcut-validation', 'ASSISTANT_SHORTCUT_INVALID'); form.querySelector('[data-assistant-form-error]')!.textContent = error instanceof Error ? error.message : label('saveFailed');}
        finally {form.inert = false;}
    }
    private async modify(id: string, action: string): Promise<void> {
        if (this.editing) return;
        const shortcuts = [...this.state.shortcuts], index = shortcuts.findIndex(item => item.id === id); if (index < 0) return;
        if (action === 'remove') shortcuts.splice(index, 1);
        else {const next = index + (action === 'up' ? -1 : 1); if (next < 0 || next >= shortcuts.length) return; [shortcuts[index], shortcuts[next]] = [shortcuts[next], shortcuts[index]];}
        try {await this.persist({...this.state, shortcuts}); this.render();} catch {this.error = label('saveFailed'); this.render();}
    }
    private async persist(state: AssistantMenuState): Promise<void> {
        if (this.storageError) throw new Error(this.storageError);
        const started = performance.now(), operationId = randomUUID(); this.busy = true;
        try {this.options.documents.write(ASSISTANT_MENU_DOCUMENT, state); await this.options.documents.flush(); if (!this.closed) this.state = state;
            log.info('assistant.settings', {operationId, stage: 'persist', result: 'success', count: state.shortcuts.length, durationMs: Math.round(performance.now() - started)});
        } catch {this.report('settings-write', 'ASSISTANT_SETTINGS_WRITE_FAILED', operationId, performance.now() - started); throw new Error(label('saveFailed'));}
        finally {this.busy = false;}
    }
    private async markRead(item: AssistantEvent): Promise<boolean> {return this.markEventsRead([item]);}
    private async markEventsRead(items: AssistantEvent[]): Promise<boolean> {
        const clearable = items.filter(item => !item.requiresAction);
        if (!clearable.length) return true;
        const seen = Object.fromEntries([...Object.entries(this.state.seen), ...clearable.map(item => [item.id, item.revision])].slice(-2000));
        const operationId = randomUUID(), started = performance.now(); this.busy = true; this.render();
        try {
            await this.persist({...this.state, seen});
            for (const item of clearable) this.selectedEvents.delete(item.id);
            this.error = ''; this.updateCount();
            log.info('assistant.events.clear', {operationId, stage: 'persist', result: 'success', count: clearable.length, durationMs: Math.round(performance.now() - started)});
            return true;
        } catch {
            this.error = this.storageError || label('saveFailed');
            this.report('events-clear', 'ASSISTANT_EVENTS_CLEAR_FAILED', operationId, performance.now() - started); return false;
        } finally {this.busy = false; this.render();}
    }
    private async openEvent(item: AssistantEvent): Promise<void> {await this.navigate(async () => {await this.options.navigate(item.target); return item.requiresAction ? undefined : this.markRead(item);});}
    private async openShortcut(item: AssistantShortcut): Promise<void> {await this.navigate(async () => this.options.navigate(await shortcutNavigation(item.target, this.options.services.projects)));}
    private async navigate(action: () => Promise<void | boolean>): Promise<void> {
        this.busy = true;
        const started = performance.now();
        try {const completed = await action(); if (!this.closed && completed !== false) this.dialog.close();}
        catch {if (!this.closed) {this.error = label('openFailed'); this.render();} this.report('navigate', 'ASSISTANT_TARGET_OPEN_FAILED', undefined, performance.now() - started);}
        finally {this.busy = false; if (this.dialog.open && !this.editing) this.render();}
    }
    private icon(name: 'assistant' | 'markRead', fallback: 'nav' | 'markRead'): string {
        const icon = ACTION_ICONS[name];
        if (typeof icon === 'string' && icon) return icon;
        if (!this.missingIcons.has(name)) {this.missingIcons.add(name); this.report('icon-' + name, 'ASSISTANT_ICON_UNAVAILABLE');}
        return escape(label(fallback));
    }
    private report(stage: string, code: string, operationId = randomUUID(), durationMs = 0): void {log.warn('assistant.menu', {operationId, stage, result: 'failure', code, durationMs: Math.round(durationMs)});}
    close(): void {
        if (this.closed) return; this.closed = true; clearTimeout(this.timer); this.lifetime.abort();
        for (const release of this.releases.reverse()) release(); this.dialog.remove();
    }
}
