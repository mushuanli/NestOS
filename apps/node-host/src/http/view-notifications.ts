import type { Call, Reply } from '@itookit/app-transport/rpc';
import type {ApplicationViewEvent} from '@itookit/app-contracts/services';

interface NotificationStream { destroyed: boolean; writableLength: number; write(frame: string): unknown; end(): unknown; }

/** Preserve event order while computing and transmitting one view update per short batch. */
export class ViewNotifications {
    private calls: Call[] = [];
    private viewEvents: ApplicationViewEvent[] = [];
    private timer?: ReturnType<typeof setTimeout>;
    private closed = false;
    private running = false;
    private dirty = false;
    private inFlight = 0;
    private queuedBytes = 0;
    private inFlightBytes = 0;
    constructor(private readonly stream: () => NotificationStream | undefined, private readonly refresh: () => Promise<Reply['updates']>,
        private readonly report: (error: unknown) => void, private readonly delay = 16) {}
    enqueue(call?: Call): Promise<Reply> {
        const stream = this.stream();
        if (this.closed || !stream || stream.destroyed) return Promise.resolve({ value: null });
        const bytes = call ? Buffer.byteLength(JSON.stringify(call)) : 0;
        if ((call && this.calls.length + this.viewEvents.length + this.inFlight >= 256) || this.queuedBytes + this.inFlightBytes + bytes > 1024 * 1024 || stream.writableLength > 1024 * 1024) {
            stream.end(); this.close(); return Promise.resolve({ value: null });
        }
        if (call) { this.calls.push(call); this.queuedBytes += bytes; }
        this.dirty = true; this.schedule();
        return Promise.resolve({ value: null });
    }
    enqueueView(event: ApplicationViewEvent): void {
        if (this.closed) return;
        this.viewEvents.push(event); this.queuedBytes += Buffer.byteLength(JSON.stringify(event));
        if (this.calls.length + this.viewEvents.length + this.inFlight > 256 || this.queuedBytes + this.inFlightBytes > 1024 * 1024) {
            this.stream()?.end(); this.close(); return;
        }
        void this.enqueue();
    }
    private schedule(): void {
        if (this.closed || this.running || this.timer || !this.dirty) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.flush().catch(error => {
                this.close(); this.stream()?.end(); this.report(error);
            });
        }, this.delay);
    }
    private async flush(): Promise<void> {
        const stream = this.stream(); if (this.closed || !stream || stream.destroyed) return;
        const calls = this.calls.splice(0), viewEvents = this.viewEvents.splice(0);
        this.inFlight = calls.length + viewEvents.length; this.running = true; this.dirty = false;
        this.inFlightBytes = this.queuedBytes; this.queuedBytes = 0;
        try {
            const updates = await this.refresh();
            if (this.closed || stream.destroyed) return;
            if (stream.writableLength > 1024 * 1024) { stream.end(); this.close(); }
            else if (calls.length || viewEvents.length || updates?.length) stream.write(`data: ${JSON.stringify({ calls, updates, ...(viewEvents.length ? {viewEvents} : {}) })}\n\n`);
        } finally { this.inFlight = 0; this.inFlightBytes = 0; this.running = false; this.schedule(); }
    }
    close(): void { this.closed = true; this.dirty = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.calls.length = 0; this.viewEvents.length = 0; this.queuedBytes = 0; }
}
