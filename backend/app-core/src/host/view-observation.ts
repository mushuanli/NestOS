import {FSError} from '@itookit/vfs-core';
import type {ApplicationViewEvent, ApplicationViewSources, ApplicationViewObservation, LocalApplicationServices, WorkbenchView} from '@itookit/app-contracts/services';

/** One browser owns this bounded journal; source subscriptions precede initial reads. */
export class ViewObservation implements ApplicationViewObservation {
    private sequence = 0;
    private closed = false;
    private bytes = 0;
    private readonly history: Array<{event: ApplicationViewEvent; bytes: number}> = [];
    private readonly listeners = new Set<(event: ApplicationViewEvent) => void>();
    private readonly releases: Array<() => void> = [];
    constructor(private readonly services: LocalApplicationServices) {
        try { this.attachSources(services); }
        catch (error) {
            this.closed = true;
            const failures = this.releaseSources();
            if (failures.length) throw new AggregateError([error, ...failures], 'View observation initialization failed');
            throw error;
        }
    }
    private attachSources(services: LocalApplicationServices): void {
        this.releases.push(services.sessionRepository.subscribe?.(event => this.publish('repository', event)) ?? (() => {}));
        this.releases.push(services.sessionFiles.subscribe(() => this.publish('files', undefined)));
        this.releases.push(services.kernel.kernel.onChanged(event => this.publish('kernel', event)));
        this.releases.push(services.sessionManager.onEvent(event => this.publish('session', event)));
        this.releases.push(services.sessionManager.onGlobalEvent(event => this.publish('global', event)));
        this.releases.push(services.agentService.onChange(() => this.publish('agents', undefined)));
        if (services.projects) {
            this.releases.push(services.projects.favorites.subscribe(() => this.publish('favorites', undefined)));
            this.releases.push(services.projects.drafts.onPromoted(event => this.publish('draft', event)));
        }
        if (services.projects?.remoteMounts) this.releases.push(services.projects.remoteMounts.onChange(() => this.publish('mounts', undefined)));
    }
    async addChat(view: WorkbenchView, sessionId?: string): Promise<void> {
        if (view.chat?.configuration) this.releases.push(view.chat.configuration.subscribe(() => this.publish('configuration', undefined)));
        if (sessionId && view.chat?.sessionSkills) {
            const stop = await view.chat.sessionSkills.onChange(sessionId, () => this.publish('skills', {sessionId}));
            if (this.closed) stop(); else this.releases.push(stop);
        }
    }
    getViewCursor(): number { return this.sequence; }
    getSessionBaseline() {return {cursor: this.sequence, snapshot: this.services.sessionManager.getSnapshot()};}
    changedSince(after: number, topics: ApplicationViewEvent['topic'][], sessionId?: string): boolean {
        return after < (this.history[0]?.event.sequence ?? this.sequence + 1) - 1
            || this.history.some(({event}) => event.sequence > after && topics.includes(event.topic)
                && (!sessionId || this.affectsSession(event, sessionId)));
    }
    private affectsSession(event: ApplicationViewEvent, sessionId: string): boolean {
        if (event.topic === 'kernel') return event.value.sessionId === sessionId;
        if (event.topic === 'repository') return !event.value?.sessionId || event.value.sessionId === sessionId;
        return true;
    }
    async observeView(after: number, listener: (event: ApplicationViewEvent) => void): Promise<() => void> {
        if (this.closed || !Number.isSafeInteger(after) || after < 0 || after > this.sequence
            || after < (this.history[0]?.event.sequence ?? this.sequence + 1) - 1) throw new FSError('ECAPABILITY', 'View observation expired');
        this.listeners.add(listener);
        try { for (const {event} of this.history) if (event.sequence > after) listener(event); }
        catch (error) { this.listeners.delete(listener); throw error; }
        return () => {this.listeners.delete(listener);};
    }
    async dispose(): Promise<void> {
        if (this.closed) return;
        this.closed = true; this.listeners.clear(); this.history.length = 0;
        const errors = this.releaseSources();
        if (errors.length) throw new AggregateError(errors, 'View observation cleanup failed');
    }
    private releaseSources(): unknown[] {
        const errors: unknown[] = [];
        for (const stop of this.releases.splice(0).reverse()) {try {stop();} catch (error) {errors.push(error);}}
        return errors;
    }
    private publish<K extends keyof ApplicationViewSources>(topic: K, value: ApplicationViewSources[K]): void {
        if (this.closed) return;
        const event = structuredClone({sequence: ++this.sequence, topic, value}) as ApplicationViewEvent;
        const bytes = JSON.stringify(event).length * 2;
        this.history.push({event, bytes}); this.bytes += bytes;
        while (this.history.length > 256 || this.bytes > 1024 * 1024) this.bytes -= this.history.shift()!.bytes;
        for (const listener of this.listeners) {try {listener(event);} catch { /* Consumers own their notification errors. */ }}
    }
}
