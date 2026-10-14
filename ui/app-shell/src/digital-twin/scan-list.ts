import { escapeAttr, escapeHTML, t } from '@itookit/common';
import { label } from './view';

type ListKind = 'plans' | 'sources';
interface Filter { query: string; enabled: string; kind: string; state: string; page: number; }
const PAGE_SIZE = 10;

export function scanListFilters(kind: ListKind): string {
    const choice = (field: string, title: string, values: string[], titles = values) => `<label>${escapeHTML(label(title))}<select data-scan-filter="${field}">
        <option value="">${escapeHTML(label('filterAll'))}</option>${values.map((value, index) => `<option value="${escapeAttr(value)}">${escapeHTML(label(titles[index]!))}</option>`).join('')}</select></label>`;
    return `<div class="twin__scan-filters"><label>${escapeHTML(label('filterSearch'))}<input type="search" data-scan-filter="query" placeholder="${escapeAttr(label(kind === 'plans' ? 'searchRules' : 'searchTargets'))}"></label>
        ${choice('enabled', 'filterEnabled', ['true', 'false'], ['enabled', 'disabled'])}
        ${kind === 'sources' ? choice('kind', 'filterSourceKind', ['file', 'session', 'harness-session'], ['filterFile', 'session', 'remoteSession']) + choice('state', 'filterSourceState', ['available', 'changed', 'deleted', 'inaccessible'], ['source.available', 'source.changed', 'source.deleted', 'source.inaccessible']) : ''}</div>
        <p class="twin__help" data-scan-list-count aria-live="polite"></p>
        <p class="twin__empty" data-scan-no-matches hidden>${escapeHTML(label('filterNoMatches'))}</p>`;
}
export function scanListPagination(): string {
    return `<nav class="twin__scan-pagination" aria-label="${escapeAttr(label('pagination'))}">
        <button type="button" data-scan-page="previous">${escapeHTML(label('previousPage'))}</button><span data-scan-page-count></span>
        <button type="button" data-scan-page="next">${escapeHTML(label('nextPage'))}</button></nav>`;
}

/** Filter and paginate in place so editing forms and focus remain intact. */
export class TwinScanLists {
    private readonly filters: Record<ListKind, Filter> = {
        plans: { query: '', enabled: '', kind: '', state: '', page: 0 },
        sources: { query: '', enabled: '', kind: '', state: '', page: 0 },
    };
    handle(event: Event): boolean {
        const control = event.target;
        if (!(control instanceof HTMLElement)) return false;
        const list = control.closest<HTMLElement>('[data-scan-list]');
        if (!list || !(control.matches('[data-scan-filter]') || control.closest('[data-scan-page]'))) return false;
        const state = this.filters[list.dataset.scanList as ListKind];
        if (event.type === 'click') {
            const action = control.closest<HTMLElement>('[data-scan-page]')?.dataset.scanPage;
            if (!action) return false;
            state.page += action === 'next' ? 1 : -1;
        } else if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
            const field = control.dataset.scanFilter as Exclude<keyof Filter, 'page'>;
            state[field] = control.value; state.page = 0;
        } else return false;
        this.applyList(list); return true;
    }
    restore(root: HTMLElement): void {
        root.querySelectorAll<HTMLElement>('[data-scan-list]').forEach(list => {
            const state = this.filters[list.dataset.scanList as ListKind];
            list.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-scan-filter]').forEach(control => {
                control.value = state[control.dataset.scanFilter as Exclude<keyof Filter, 'page'>];
            });
            this.applyList(list);
        });
    }
    private applyList(list: HTMLElement): void {
        const state = this.filters[list.dataset.scanList as ListKind], query = state.query.trim().toLocaleLowerCase();
        const rows = [...list.querySelectorAll<HTMLElement>('[data-scan-row]')];
        const matches = rows.filter(row => (!query || row.dataset.scanText?.includes(query))
            && (!state.enabled || row.dataset.scanEnabled === state.enabled)
            && (!state.kind || row.dataset.scanKind === state.kind) && (!state.state || row.dataset.scanState === state.state));
        const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
        state.page = Math.max(0, Math.min(state.page, pages - 1));
        const visible = new Set(matches.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE));
        rows.forEach(row => { row.hidden = !visible.has(row); });
        list.querySelector<HTMLElement>('[data-scan-list-count]')!.textContent = t('twin.scanListCount', { shown: visible.size, matched: matches.length, total: rows.length });
        list.querySelector<HTMLElement>('[data-scan-no-matches]')!.hidden = matches.length > 0 || rows.length === 0;
        list.querySelector<HTMLElement>('[data-scan-page-count]')!.textContent = `${state.page + 1} / ${pages}`;
        list.querySelector<HTMLButtonElement>('[data-scan-page="previous"]')!.disabled = state.page === 0;
        list.querySelector<HTMLButtonElement>('[data-scan-page="next"]')!.disabled = state.page + 1 >= pages;
    }
}
