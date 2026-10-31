import {randomUUID} from '@itookit/common';
import {FSError, SeqEventJournal, type IFileSystem, type EventCursor} from '@itookit/vfs-core';
import type {ApplicationEvents, ApplicationEventFact} from '@itookit/app-contracts/services';

/** One instance per authenticated runtime. Publication is host-only, never an RPC method. */
export class UserEventService implements ApplicationEvents {
    private constructor(readonly journal: SeqEventJournal<ApplicationEventFact>) {}
    static async open(fs: IFileSystem): Promise<UserEventService> {
        return new UserEventService(await SeqEventJournal.open(fs, '/var/lib/events/events.seq', randomUUID()));
    }
    eventBaseline() {return this.journal.baseline();}
    readEvents(after?: EventCursor, limit?: number) {return this.journal.read(after, limit);}
    onChange(listener: () => void) {return this.journal.onChange(listener);}
    async listNotifications(limit = 100) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new FSError('EINVAL', 'Invalid notification limit');
        const events = await this.retained(), head = events.head;
        const read = await this.journal.transaction(tx => tx.getState('notification-read'));
        const states = decodeRead(read);
        return {items: events.events.filter(event => event.value.notification).slice(-limit).reverse()
            .map(event => ({event, read: states.includes(event.id)})), head};
    }
    async setNotificationRead(eventId: string, read: boolean): Promise<void> {
        if (typeof eventId !== 'string' || eventId.length > 512 || typeof read !== 'boolean') throw new FSError('EINVAL', 'Invalid notification state');
        const retained = await this.retained();
        if (!retained.events.some(event => event.id === eventId && event.value.notification)) throw new FSError('ENOENT', 'Notification expired or unavailable');
        const ids = new Set(retained.events.map(event => event.id));
        await this.journal.transaction(async tx => {
            const states = new Set(decodeRead(await tx.getState('notification-read')).filter(id => ids.has(id)));
            if (read) states.add(eventId); else states.delete(eventId);
            await tx.setState('notification-read', JSON.stringify([...states]));
        });
    }
    private async retained() {
        let page = await this.journal.read(undefined, 200);
        const events = [...page.events], head = page.head;
        while (page.more && page.cursor.sequence < head.sequence) {
            page = await this.journal.read(page.cursor, 200);
            events.push(...page.events.filter(event => event.sequence <= head.sequence));
        }
        return {events, head};
    }
}
function decodeRead(raw: string | null): string[] {
    if (raw === null) return [];
    const values = JSON.parse(raw);
    if (!Array.isArray(values) || values.length > 1000 || values.some(id => typeof id !== 'string')) throw new FSError('EINVAL', 'Invalid notification state');
    return values;
}
