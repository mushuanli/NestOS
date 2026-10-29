import type {CallTargetCatalog, CallTargetChoice, CallTargetRef} from '@itookit/llm-ui';
import {isTargetRef} from '@itookit/llm-flow/contracts';
import {SessionCommand, type ICommandBus, type RootTargetCatalog} from '@itookit/llm-session/contracts';
import {createModuleLogger, randomUUID, t, ENTITY_ICONS} from '@itookit/common';

const log = createModuleLogger('SessionCallTargets');

/** Metadata reads share no submission lock and never acquire or resume an execution endpoint. */
export class SessionCallTargets {
    private snapshot: CallTargetCatalog = {entries: [], loading: true, autoSelectFirst: false};
    private pending?: Promise<void>;
    private closed = false;
    constructor(private readonly commands: ICommandBus, private readonly changed: () => void, private readonly autoSelectFirst = true) {
        this.snapshot = {...this.snapshot, autoSelectFirst};
    }
    getSnapshot(): CallTargetCatalog {return this.snapshot;}
    refresh(): Promise<void> {
        if (this.closed) return Promise.resolve();
        return this.pending ??= this.read().finally(() => {this.pending = undefined;});
    }
    async refreshCurrent(): Promise<void> {
        if (this.pending) await this.pending;
        await this.refresh();
    }
    find(target: CallTargetRef) {return this.snapshot.entries.find(entry => sameTarget(entry.target, target));}
    dispose(): void {this.closed = true;}
    private async read(): Promise<void> {
        const operationId = randomUUID(), started = Date.now();
        try {
            const catalog = await this.commands.execute<RootTargetCatalog>(SessionCommand.ListTargets);
            if (!catalog || !Array.isArray(catalog.entries) || !Array.isArray(catalog.issues)) throw new Error(t('callable.catalog.invalid'));
            const entries = catalog.entries.map(entry => choice(entry));
            if (!this.closed) this.snapshot = {entries, loading: false, autoSelectFirst: this.autoSelectFirst, label: t('chatInput.target.label'),
                ...(catalog.issues.length ? entries.length ? {message: t('callable.catalog.partial', {count: catalog.issues.length})} : {error: t('callable.catalog.unavailable')} : {})};
            log.info('chat.targets.read', {operationId, stage: 'catalog', result: entries.length ? 'success' : 'unavailable',
                code: entries.length ? 'CATALOG_READY' : catalog.issues.length ? 'CATALOG_ENTRIES_UNAVAILABLE' : 'CATALOG_EMPTY',
                durationMs: Date.now() - started, entryCount: entries.length, issueCodes: catalog.issues.map(issue => issue.code)});
        } catch (error) {
            log.warn('chat.targets.read', {operationId, stage: 'catalog', result: 'failed', code: 'CATALOG_READ_FAILED', durationMs: Date.now() - started});
            if (!this.closed) this.snapshot = {...this.snapshot, loading: false,
                error: error instanceof Error ? error.message : t('callable.catalog.unavailable')};
        }
        if (!this.closed) this.changed();
    }
}

function choice(entry: RootTargetCatalog['entries'][number]): CallTargetChoice {
    if (!entry || !isTargetRef(entry.target) || typeof entry.name !== 'string') throw new Error(t('callable.catalog.invalid'));
    const target = {...entry.target}, id = JSON.stringify([target.kind, target.id, target.version, target.digest]);
    const label = entry.name;
    return {id, target, label, group: t(entry.target.kind === 'flow' ? 'callable.target.flow' : 'callable.target.agent'),
        icon: entry.icon ?? (entry.target.kind === 'flow' ? ENTITY_ICONS.flow : ENTITY_ICONS.agent), description: entry.description, ...(entry.input ? {inputContract: {targetId: id, target, label,
        signature: {id: entry.input.flowId, revision: entry.input.revision, digest: entry.input.digest}}} : {})};
}
function sameTarget(left: CallTargetRef, right: CallTargetRef): boolean {
    return left.kind === right.kind && left.id === right.id && left.version === right.version && left.digest === right.digest;
}
