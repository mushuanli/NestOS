import type { OwnedConversationView } from './conversation-system';

interface Entry {
    view: OwnedConversationView;
    releaseDrafts(): Promise<void>;
    unsubscribe(): void;
    retired: boolean;
    disposal?: Promise<void>;
}

/** Browser detachment releases bindings; the runtime retains unfinished projection work. */
export class ConversationViews {
    private readonly entries = new Set<Entry>();
    private closing?: Promise<void>;
    own(view: OwnedConversationView, releaseDrafts: () => Promise<void>): OwnedConversationView {
        const entry: Entry = { view, releaseDrafts, retired: false, unsubscribe: () => {} };
        entry.unsubscribe = view.sessionManager.onGlobalEvent(() => {
            if (entry.retired) void Promise.resolve().then(() => this.releaseIfIdle(entry))
                .catch(error => console.warn('Conversation view cleanup deferred', error));
        });
        this.entries.add(entry);
        return { sessionManager: view.sessionManager, commandBus: view.commandBus, dispose: () => {
            if (!entry.retired) { entry.retired = true; view.sessionManager.unbindSession(); }
            return this.releaseIfIdle(entry);
        } };
    }
    private releaseIfIdle(entry: Entry): Promise<void> {
        if (entry.disposal) return entry.disposal;
        const busy = entry.view.sessionManager.getAllSessions().some(session => session.status === 'running' || session.status === 'queued');
        return busy || entry.view.sessionManager.hasPendingInstructions?.() ? Promise.resolve() : this.finish(entry);
    }
    private finish(entry: Entry): Promise<void> {
        return entry.disposal ??= (async () => {
            entry.unsubscribe();
            try { await entry.releaseDrafts(); } finally { await entry.view.dispose(); }
            this.entries.delete(entry);
        })();
    }
    /** Runtime shutdown owns the remaining views and runs before Kernel/storage disposal. */
    close(): Promise<void> {
        return this.closing ??= (async () => {
            const results = await Promise.allSettled([...this.entries].map(entry => this.finish(entry)));
            const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
            if (errors.length) throw new AggregateError(errors, 'Conversation view cleanup failed');
        })();
    }
}
