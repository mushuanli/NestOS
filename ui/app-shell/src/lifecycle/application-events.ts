import {createModuleLogger, randomUUID} from '@itookit/common';
import {ApplicationEventFeed} from '@itookit/app-transport/application';
import type {ApplicationEvents, ApplicationEventFact} from '@itookit/app-contracts/services';
import type {EventCursor} from '@itookit/vfs-core';

const log = createModuleLogger('shell-events');
const reset: ApplicationEventFact = {type: 'runtime.reset'};

/** One browser owns one cursor. Events invalidate views and never replay commands. */
export class ShellApplicationEvents {
    private cursor?: EventCursor;
    private feed?: ApplicationEventFeed;
    private pending?: Promise<void>;
    private timer?: ReturnType<typeof setInterval>;
    private closed = false;
    private started = false;
    private needsReset = false;
    generation = 0;
    constructor(private readonly source: ApplicationEvents,
        private readonly invalidate: (event: ApplicationEventFact) => void | Promise<void>,
        private readonly visible: () => boolean) {}

    /** Capture before loading snapshots; preloaded snapshots need a fresh invalidation. */
    async prepare(preloaded = false): Promise<void> {
        const started = Date.now();
        this.needsReset = preloaded;
        try {this.cursor = await this.source.eventBaseline();}
        catch (error) {this.needsReset = true; this.report('baseline', error, started);}
    }
    async start(): Promise<void> {
        if (this.closed || this.started) return;
        this.started = true;
        this.timer = setInterval(() => {if (this.visible()) void this.refresh();}, 15000);
        await this.refresh();
    }
    refresh(): Promise<void> {
        if (this.closed || !this.started) return Promise.resolve();
        const started = Date.now();
        return this.pending ??= this.connect().catch(error => this.report('replay', error, started))
            .finally(() => {this.pending = undefined;});
    }
    close(): void {
        this.closed = true; clearInterval(this.timer); this.feed?.close();
    }
    private async connect(): Promise<void> {
        const started = Date.now(), operationId = randomUUID();
        if (!this.cursor) {this.cursor = await this.source.eventBaseline(); this.needsReset = true;}
        if (this.closed) return;
        if (this.needsReset) {await this.deliver(reset); this.needsReset = false;}
        if (this.closed) return;
        if (this.feed) {await this.feed.refresh(); return;}
        const feed = new ApplicationEventFeed(this.source, this.cursor, {
            receive: event => ['runtime.reset', 'source.reset'].includes(event.value.type) ? undefined : this.deliver(event.value),
            reset: () => this.deliver(reset), failure: error => this.report('consume', error),
        });
        this.feed = feed;
        try {await feed.start();}
        catch (error) {this.cursor = feed.getCursor(); feed.close(); this.feed = undefined; throw error;}
        if (!this.closed) log.info('events.subscribe', {operationId, stage: 'ready', result: 'success', durationMs: Date.now() - started});
    }
    private async deliver(event: ApplicationEventFact): Promise<void> {
        if (this.closed) return;
        this.generation++;
        await this.invalidate(event);
    }
    private report(stage: string, error: unknown, started = Date.now()): void {
        if (this.closed) return;
        const code = (error as {code?: unknown})?.code;
        log.warn('events.subscribe', {operationId: randomUUID(), stage, result: 'failure',
            durationMs: Date.now() - started,
            code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'EVENT_FEED_FAILED'});
    }
}

/** Route hints to the workspace that owns the corresponding snapshots. */
export function workspaceConsumesEvent(kind: string | undefined, event: ApplicationEventFact): boolean {
    if (event.type === 'runtime.reset' || event.type === 'source.reset') return true;
    if (kind === 'chat') return /^(?:session\.|task\.|repository\.|node:)/.test(event.type);
    if (kind === 'kanban') return event.type.startsWith('kanban.');
    if (kind === 'twin') return event.type === 'scanner.changed';
    return kind !== 'toolbox' && event.type.startsWith('node:');
}
