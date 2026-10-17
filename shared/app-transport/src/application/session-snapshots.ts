import type {ApplicationViewObservation} from '@itookit/app-contracts/services';

type Snapshot = Record<string, any>;

/** Own immutable wire projections; domain objects remain mutable and private. */
class SessionSnapshots {
    private rows: any[] = [];
    private readonly owners = new Map<string, string>();
    private dirty = new Set<string>();
    private reset = true;
    private sessionId?: string;
    private projected?: { type: string; delta: string };
    change(event: any): void {
        if (event?.type === 'session_status_changed' || event?.type === 'session_unread_updated') return;
        if (this.projected && this.projected.type === event?.type && this.projected.delta === event.payload?.delta) { this.projected = undefined; return; }
        this.projected = undefined;
        const owner = event?.type === 'message:updated' && this.owners.get(event.payload?.messageId);
        if (owner) {
            this.dirty.add(owner);
            if (typeof event.payload.delta === 'string') this.projected = { type: event.payload.field === 'thought' ? 'stream:thinking' : 'stream:content', delta: event.payload.delta };
        } else this.reset = true;
    }
    snapshot(source: Snapshot): Snapshot {
        const key = Array.isArray(source.sessions) ? 'sessions' : 'messages', rows = source[key];
        if (!Array.isArray(rows)) return source;
        if (this.sessionId !== source.sessionId) this.reset = true;
        this.sessionId = source.sessionId;
        if (this.reset || this.dirty.size) this.update(rows);
        return { ...source, [key]: this.rows };
    }
    private update(rows: any[]): void {
        if (this.reset) this.owners.clear();
        const previous = this.reset ? new Map() : new Map(this.rows.map((row, index) => [String(row.id ?? index), row]));
        this.rows = Object.freeze(rows.map((row, index) => {
            const id = String(row.id ?? index);
            if (previous.has(id) && !this.dirty.has(id)) return previous.get(id);
            const copy = freezeData(structuredClone(row)); this.index(copy, id); return copy;
        })) as unknown as any[];
        this.reset = false; this.dirty.clear();
    }
    private index(value: any, owner: string): void {
        if (!value || typeof value !== 'object') return;
        if (typeof value.id === 'string') this.owners.set(value.id, owner);
        for (const child of Object.values(value)) this.index(child, owner);
    }
}
const views = new WeakMap<object, SessionSnapshots>();
function view(value: object): SessionSnapshots {
    let snapshot = views.get(value);
    if (!snapshot) { snapshot = new SessionSnapshots(); views.set(value, snapshot); }
    return snapshot;
}
function freezeData<T>(value: T): T {
    if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
        for (const child of Object.values(value)) freezeData(child);
        Object.freeze(value);
    }
    return value;
}
export function sessionSnapshot(value: any, name: string): unknown {
    return name === 'getSnapshot' ? view(value).snapshot(value.getSnapshot()) : value[name]();
}
export function observeSession(value: any, listener: (...events: any[]) => void): () => void {
    const projection = view(value); projection.change(undefined);
    const changed = (event: unknown) => { projection.change(event); listener(event); };
    const releases = [value.onGlobalEvent?.(changed), value.onEvent?.(changed)];
    return () => { for (const release of releases) release?.(); };
}
export function applicationSnapshot(value: ApplicationViewObservation, name: string): unknown {
    if (name !== 'getSessionBaseline') return value.getViewCursor();
    const baseline = value.getSessionBaseline();
    return {cursor: baseline.cursor, snapshot: view(value).snapshot(baseline.snapshot)};
}
export function observeApplication(value: ApplicationViewObservation, listener: () => void): Promise<() => void> {
    const projection = view(value); projection.change(undefined);
    return value.observeView(value.getViewCursor(), event => {
        if (event.topic === 'session' || event.topic === 'global') projection.change(event.value);
        listener();
    });
}
