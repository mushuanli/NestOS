/** Ordered writes with explicit failure state; a later edit can retry after a transient failure. */
export class DraftSaveQueue {
    private pending: Promise<void> = Promise.resolve();
    private revision = 0;
    private saved = 0;
    get dirty(): boolean { return this.saved !== this.revision; }
    constructor(private readonly write: (data: string) => Promise<void>, private readonly changed: (error?: unknown) => void) {}
    save(encoded: Promise<string>): void {
        const revision = ++this.revision;
        void encoded.catch(() => {});
        this.pending = this.pending.catch(() => {}).then(async () => { await this.write(await encoded); this.saved = revision; });
        void this.pending.then(() => { if (revision === this.revision) this.changed(); },
            error => { if (revision === this.revision) this.changed(error); });
    }
    flush(): Promise<void> { return this.pending; }
}
