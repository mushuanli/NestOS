import {isTargetRef, sameTargetRef, type TargetRef} from '@itookit/llm-flow/contracts';
import type {RootCallTarget, RootTargetCatalog} from '@itookit/llm-session/contracts';
import {ENTITY_ICONS, createModuleLogger, randomUUID, t} from '@itookit/common';
import type {PopupItem} from './plugins/PopupPanel';

const log = createModuleLogger('workspace-call-targets');

/** Catalog identity is independent of the legacy Agent preference and the currently running call. */
export class WorkspaceCallTargets {
    private entries: RootCallTarget[] = [];
    private pending?: Promise<void>;
    private closed = false;
    private ready = false;
    private error?: string;
    private partial?: string;
    constructor(private readonly read: () => Promise<RootTargetCatalog>, private readonly changed: () => void) {}
    find(target?: TargetRef): RootCallTarget | undefined {return this.entries.find(entry => sameTargetRef(entry.target, target));}
    initial(agentId: string): TargetRef | undefined {return this.entries.find(entry => entry.target.kind === 'agent' && entry.target.id === agentId)?.target;}
    select(key: string): RootCallTarget | undefined {return this.entries.find(entry => targetKey(entry.target) === key);}
    issue(target?: TargetRef): string | undefined {
        return this.error ?? (!this.ready ? t('callable.catalog.loading') : !this.find(target) ? t('callable.catalog.changed') : undefined);
    }
    notice(): string | undefined {return this.partial;}
    items(): PopupItem[] {return this.entries.map(entry => ({id: targetKey(entry.target), label: entry.name,
        icon: entry.icon ?? (entry.target.kind === 'flow' ? ENTITY_ICONS.flow : ENTITY_ICONS.agent), description: entry.description,
        group: entry.target.kind === 'flow' ? t('callable.target.flow') : t('callable.target.agent')}));}
    refresh(): Promise<void> {
        if (this.closed) return Promise.resolve();
        return this.pending ??= this.load().finally(() => {this.pending = undefined;});
    }
    async refreshCurrent(): Promise<void> {
        if (this.pending) await this.pending;
        await this.refresh();
    }
    dispose(): void {this.closed = true;}
    private async load(): Promise<void> {
        const operationId = randomUUID(), started = Date.now();
        try {
            const catalog = await this.read();
            assertCatalog(catalog);
            if (this.closed) return;
            this.entries = structuredClone(catalog.entries); this.ready = true; this.error = undefined;
            this.partial = catalog.issues.length ? t('callable.catalog.partial', {count: catalog.issues.length}) : undefined;
            log.info('call.targets.list', {operationId, stage: 'metadata', result: this.partial ? 'partial' : 'success', count: this.entries.length, issueCount: catalog.issues.length, durationMs: Date.now() - started});
        } catch (error) {
            if (this.closed) return;
            const value = (error as {code?: unknown})?.code;
            const code = typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : 'CALL_TARGET_CATALOG_READ_FAILED';
            this.error = `${t('callable.catalog.unavailable')} (${code})`;
            log.warn('call.targets.list', {operationId, stage: 'metadata', result: 'failure', code, durationMs: Date.now() - started});
        }
        this.changed();
    }
}

function assertCatalog(catalog: RootTargetCatalog): void {
    if (!catalog || !Array.isArray(catalog.issues) || !Array.isArray(catalog.entries)
        || catalog.entries.some(entry => !entry || !isTargetRef(entry.target) || typeof entry.name !== 'string'))
        throw Object.assign(new Error(t('callable.catalog.invalid')), {code: 'CALL_TARGET_CATALOG_INVALID'});
}

function targetKey(target: TargetRef): string {return JSON.stringify([target.kind, target.id, target.version, target.digest]);}
