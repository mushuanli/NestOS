import {createModuleLogger, randomUUID} from '@itookit/common';

const log = createModuleLogger('workbench-windows');
/** Application-owned window metadata; editor instances remain in their workspace. */
export interface WorkbenchWindow {
    id: string; title: string; scope?: string; context?: string; location?: string;
    active: boolean;
    activate(): Promise<void>;
    pinned: boolean; dirty: boolean; failed: boolean; selected: boolean;
    header(): HTMLElement; row(): HTMLElement;
    select(selected: boolean): void;
    close(): Promise<void>;
}
interface WindowSource {
    items(): WorkbenchWindow[];
    describe(): void;
    reopen(): Promise<void>;
}
export interface WorkbenchWindowBinding {
    registry: WorkbenchWindows;
    id: string;
    isActive(): boolean;
    navigate(id: string): Promise<void>;
}

export class WorkbenchWindows {
    private readonly sources = new Map<string, {source: WindowSource; render(): void}>();
    private readonly closed: string[] = [];
    query = '';
    error?: string;
    report(error: unknown): void {this.error = error instanceof Error ? error.message : String(error); this.changed();}
    clearError(): void {this.error = undefined; this.changed();}
    register(id: string, source: WindowSource, render: () => void): () => void {
        if (this.sources.has(id)) throw new Error(`Window source already registered: ${id}`);
        this.sources.set(id, {source, render}); this.changed();
        return () => { this.sources.delete(id); this.changed(); };
    }
    items(): WorkbenchWindow[] { return [...this.sources.values()].flatMap(entry => entry.source.items()).sort((a, b) => Number(b.pinned) - Number(a.pinned)); }
    matches(item: WorkbenchWindow): boolean {
        const text = [item.scope, item.title, item.context, item.location].filter(Boolean).join(' ').toLocaleLowerCase();
        return this.query.trim().toLocaleLowerCase().split(/\s+/).every(term => text.includes(term));
    }
    setQuery(query: string): void { this.query = query; this.changed(); }
    changed(): void { for (const entry of this.sources.values()) entry.render(); }
    describe(): void { for (const entry of this.sources.values()) entry.source.describe(); }
    selectAll(selected: boolean): void {
        for (const item of this.items()) if (!item.pinned && this.matches(item)) item.select(selected);
        this.changed();
    }
    async closeSelected(): Promise<void> { await this.close(this.items().filter(item => item.selected && !item.pinned)); }
    async closeSaved(): Promise<void> { await this.close(this.items().filter(item => !item.pinned && !item.dirty && !item.failed)); }
    private async close(items: WorkbenchWindow[]): Promise<void> {
        const started = performance.now(), operationId = randomUUID(); let failure: unknown;
        for (const item of items) { try { await item.close(); } catch (error) { failure ??= error; } }
        log.debug('windows.close', {operation: 'windows.close', operationId, stage: 'dispose', result: failure ? 'failure' : 'success',
            code: failure ? String((failure as {code?: string}).code ?? 'WINDOW_CLOSE_FAILED') : undefined, count: items.length, durationMs: Math.round(performance.now() - started)});
        if (failure) {this.report(failure); throw failure;}
    }
    async cycle(step: number): Promise<void> {
        const items = this.items(), index = items.findIndex(item => item.active);
        await items[(index + step + items.length) % items.length]?.activate();
    }
    noteClosed(id: string): void { this.closed.push(id); }
    async reopen(): Promise<void> {
        const id = this.closed.pop(); if (id) await this.sources.get(id)?.source.reopen();
    }
}
