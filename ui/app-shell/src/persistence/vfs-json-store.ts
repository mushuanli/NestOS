import type { ApplicationBackend } from '@itookit/app-contracts/services';

type DocumentPort = Pick<ApplicationBackend, 'readUiDocuments' | 'writeUiDocuments'>;

/** Coalesce presentation changes; persistence and upsert stay behind the backend port. */
export class VfsJsonStore {
    private readonly pending = new Map<string, string>();
    private readonly saved = new Map<string, string>();
    private readonly reads = new Map<string, Array<(value: unknown) => void>>();
    private reading = false;
    private writing?: Promise<void>;
    constructor(private readonly backend: DocumentPort) {}

    read(name: string): Promise<unknown> {
        const content = this.pending.get(name);
        if (content !== undefined) return Promise.resolve(JSON.parse(content));
        const pending = new Promise(resolve => this.reads.set(name, [...(this.reads.get(name) ?? []), resolve]));
        if (!this.reading) { this.reading = true; queueMicrotask(() => { void this.readBatch(); }); }
        return pending;
    }
    private async readBatch(): Promise<void> {
        const readers = new Map(this.reads); this.reads.clear(); this.reading = false;
        let values: Record<string, unknown> = {};
        try {
            const names = [...readers.keys()];
            for (let offset = 0; offset < names.length; offset += 32)
                Object.assign(values, await this.backend.readUiDocuments(names.slice(offset, offset + 32)));
        }
        catch (error) { console.error('[ui-state] failed to read', error); }
        for (const [name, callbacks] of readers) {
            const content = this.pending.get(name), value = content === undefined ? values[name] : JSON.parse(content);
            if (value !== undefined && content === undefined) this.saved.set(name, JSON.stringify(value));
            for (const resolve of callbacks) resolve(value);
        }
    }
    write(name: string, value: unknown): void {
        const content = JSON.stringify(value);
        if (content === (this.pending.get(name) ?? this.saved.get(name))) return;
        this.pending.set(name, content);
        if (!this.writing) {
            this.writing = Promise.resolve().then(() => this.drain());
            void this.writing.catch(error => console.error('[ui-state] failed to persist', error));
        }
    }
    private async drain(): Promise<void> {
        try {
            while (this.pending.size) {
                const batch = [...this.pending].slice(0, 32);
                await this.backend.writeUiDocuments(Object.fromEntries(batch.map(([name, content]) => [name, JSON.parse(content)])));
                for (const [name, content] of batch) {
                    this.saved.set(name, content);
                    if (this.pending.get(name) === content) this.pending.delete(name);
                }
            }
        } finally { this.writing = undefined; }
    }
    /** Retry failed writes, and report failures to the caller retaining the draft. */
    async flush(): Promise<void> {
        if (!this.writing && this.pending.size) this.writing = this.drain();
        await this.writing;
    }
}
