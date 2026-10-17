import type { ComposerDraft } from './contracts';

/** Coalesce edits while preserving write order and an explicit flush barrier. */
export class DraftWriter {
    private latest?: ComposerDraft;
    private saved = -1;
    private timer?: ReturnType<typeof setTimeout>;
    private tail = Promise.resolve();
    constructor(private readonly write?: (draft: ComposerDraft) => Promise<void>,
        private readonly failed: (error: unknown) => void = () => {}) {}
    changed(draft: ComposerDraft): void {
        this.latest = draft;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.flush().catch(this.failed); }, 150);
    }
    flush(): Promise<void> {
        clearTimeout(this.timer);
        const captured = this.latest;
        const task = this.tail.catch(() => {}).then(async () => {
            if (!captured || !this.write || captured.revision <= this.saved) return;
            await this.write(captured);
            this.saved = captured.revision;
        });
        this.tail = task;
        return task;
    }
    stop(): void { clearTimeout(this.timer); }
}
