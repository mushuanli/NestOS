import type {CallTargetCatalog, CallTargetChoice, CallTargetRef} from '@itookit/llm-ui';
import {isTargetRef} from '@itookit/llm-flow/contracts';
import {SessionCommand, type ICommandBus, type RootTargetCatalog} from '@itookit/llm-session/contracts';
import {t} from '@itookit/common';

/** Metadata reads share no submission lock and never acquire or resume an execution endpoint. */
export class SessionCallTargets {
    private snapshot: CallTargetCatalog = {entries: [], loading: true};
    private pending?: Promise<void>;
    private closed = false;
    constructor(private readonly commands: ICommandBus, private readonly changed: () => void) {}
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
        try {
            const catalog = await this.commands.execute<RootTargetCatalog>(SessionCommand.ListTargets);
            if (!catalog || !Array.isArray(catalog.entries) || !Array.isArray(catalog.issues)) throw new Error(t('callable.catalog.invalid'));
            const entries = catalog.entries.map(entry => choice(entry));
            if (!this.closed) this.snapshot = {entries, loading: false,
                ...(catalog.issues.length ? {message: t('callable.catalog.partial', {count: catalog.issues.length})} : {})};
        } catch (error) {
            if (!this.closed) this.snapshot = {...this.snapshot, loading: false,
                error: error instanceof Error ? error.message : t('callable.catalog.unavailable')};
        }
        if (!this.closed) this.changed();
    }
}

function choice(entry: RootTargetCatalog['entries'][number]): CallTargetChoice {
    if (!entry || !isTargetRef(entry.target) || typeof entry.name !== 'string') throw new Error(t('callable.catalog.invalid'));
    const target = {...entry.target}, id = JSON.stringify([target.kind, target.id, target.version, target.digest]);
    const label = `${target.kind === 'flow' ? 'Flow' : 'Agent'} · ${entry.name}`;
    return {id, target, label, description: entry.description, ...(entry.input ? {inputContract: {targetId: id, target, label,
        signature: {id: entry.input.flowId, revision: entry.input.revision, digest: entry.input.digest}}} : {})};
}
function sameTarget(left: CallTargetRef, right: CallTargetRef): boolean {
    return left.kind === right.kind && left.id === right.id && left.version === right.version && left.digest === right.digest;
}
