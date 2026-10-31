import type {ApplicationEvents, ApplicationEventFact} from '@itookit/app-contracts/services';
import type {EventCursor, JournalEvent} from '@itookit/vfs-core';

export interface EventFeedHandlers {
    receive(event: JournalEvent<ApplicationEventFact>): void | Promise<void>;
    /** Reload domain snapshots; called when retention or a new storage incarnation invalidates the cursor. */
    reset(): void | Promise<void>;
    failure(error: unknown): void;
}

/** One instance per browser/view. It never marks notifications read or acknowledges other consumers. */
export class ApplicationEventFeed {
    private cursor: EventCursor;
    private stop?: () => void;
    private pending?: Promise<void>;
    private dirty = false;
    private closed = false;
    constructor(private readonly source: ApplicationEvents, after: EventCursor, private readonly handlers: EventFeedHandlers) {
        this.cursor = {...after};
    }
    async start(): Promise<void> {
        if (this.closed || this.stop) return;
        this.stop = this.source.onChange(() => {void this.refresh().catch(error => this.handlers.failure(error));});
        try {await this.refresh();} catch (error) {this.close(); throw error;}
    }
    getCursor(): EventCursor {return {...this.cursor};}
    close(): void {this.closed = true; this.stop?.(); this.stop = undefined;}
    refresh(): Promise<void> {
        if (this.closed) return Promise.resolve();
        this.dirty = true;
        return this.pending ??= this.drain().finally(() => {
            this.pending = undefined;
            if (this.dirty && !this.closed) void this.refresh().catch(error => this.handlers.failure(error));
        });
    }
    private async drain(): Promise<void> {
        while (this.dirty && !this.closed) {
            this.dirty = false;
            let page;
            try {page = await this.source.readEvents(this.cursor);}
            catch (error) {
                if ((error as {code?: string}).code !== 'ECONFLICT') throw error;
                const baseline = await this.source.eventBaseline();
                await this.handlers.reset();
                if (this.closed) return;
                this.cursor = baseline; this.dirty = true; continue;
            }
            for (const event of page.events) {
                if (this.closed) return;
                if (event.value.type === 'runtime.reset' || event.value.type === 'source.reset') await this.handlers.reset();
                await this.handlers.receive(event);
                this.cursor = {streamId: page.cursor.streamId, sequence: event.sequence};
            }
            this.dirty ||= page.more;
        }
    }
}
