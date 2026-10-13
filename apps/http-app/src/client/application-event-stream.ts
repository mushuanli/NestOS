import type { ApplicationEvent } from '@itookit/app-core/application/contracts';

interface EventSourceLike {
    onmessage: ((event: MessageEvent<string>) => void) | null;
    onerror: ((event: Event) => void) | null;
    onopen?: ((event: Event) => void) | null;
    close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

/** EventSource owns reconnects; cursor replay is separate from mutation delivery. */
export class ApplicationEventStream {
    private source?: EventSourceLike;
    constructor(private readonly endpoint: string, private readonly clientId: string,
        private readonly publish: (event: ApplicationEvent) => void,
        private readonly createSource: EventSourceFactory = url => new EventSource(url)) {}
    start(): void {
        if (this.source) return;
        const source = this.createSource(`${this.endpoint}/events?clientId=${encodeURIComponent(this.clientId)}`);
        this.source = source;
        let connected = false;
        source.onopen = () => {
            if (connected) this.publish({ kind: 'invalidate', scope: 'all', revision: 0 });
            connected = true;
        };
        source.onmessage = message => {
            try {
                const event = JSON.parse(message.data) as ApplicationEvent;
                if (!['session', 'registry', 'invalidate'].includes(event.kind) || !Number.isSafeInteger(event.revision) || event.revision < 0)
                    throw new Error('Invalid application event');
                this.publish(event);
            } catch { this.publish({ kind: 'invalidate', scope: 'all', revision: 0 }); }
        };
        source.onerror = () => this.publish({ kind: 'invalidate', scope: 'all', revision: 0 });
    }
    close(): void { this.source?.close(); this.source = undefined; }
}
