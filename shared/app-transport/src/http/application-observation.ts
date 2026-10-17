import {FSError} from '@itookit/vfs-core';
import type {ApplicationViewEvent} from '@itookit/app-contracts/services';

/** The handshake installs the remote observer; components subscribe locally after hydration. */
export class ApplicationObservation {
    private cursor = 0;
    private readonly events: ApplicationViewEvent[] = [];
    private readonly listeners = new Set<(event: ApplicationViewEvent) => void>();
    initialize(cursor: number): void {this.cursor = cursor;}
    receive(event: ApplicationViewEvent): void {
        if (event.sequence <= this.cursor) return;
        if (event.sequence !== this.cursor + 1) throw new FSError('EIO', 'Application view event gap');
        this.cursor = event.sequence; this.events.push(event);
        if (this.events.length > 256) this.events.shift();
        for (const listener of this.listeners) listener(event);
    }
    observe(after: number, listener: (event: ApplicationViewEvent) => void): () => void {
        if (after < (this.events[0]?.sequence ?? this.cursor + 1) - 1 || after > this.cursor)
            throw new FSError('ECAPABILITY', 'Application observation expired');
        this.listeners.add(listener);
        try {for (const event of this.events) if (event.sequence > after) listener(event);}
        catch (error) {this.listeners.delete(listener); throw error;}
        return () => {this.listeners.delete(listener);};
    }
    getCursor(): number {return this.cursor;}
    close(): void {this.listeners.clear(); this.events.length = 0;}
}
