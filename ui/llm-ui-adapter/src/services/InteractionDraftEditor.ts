import {randomUUID} from '@itookit/common';
import type {InteractionDraftContent, InteractionDraftRecord, InteractionDraftScope, InteractionDraftStorage, InteractionDraftWrite} from '../domain/interaction-draft';
import {canonicalJson} from '../utils/canonical-json';

/** One mounted editor serializes writes; failures retain the original proposal for explicit retry. */
export class InteractionDraftEditor {
    private tail: Promise<void> = Promise.resolve();
    private failed?: {change: InteractionDraftWrite; error: unknown};
    private desired: InteractionDraftContent | null;
    private constructor(private storage: InteractionDraftStorage, private scope: InteractionDraftScope,
        private record: InteractionDraftRecord | undefined, private observer: (error?: unknown) => void) {this.desired = record?.content ?? null;}
    static async open(storage: InteractionDraftStorage, scope: InteractionDraftScope, report: (error?: unknown) => void): Promise<InteractionDraftEditor> {
        return new InteractionDraftEditor(storage, structuredClone(scope), await storage.read(scope), report);
    }
    get content(): InteractionDraftContent | null {return structuredClone(this.record?.content ?? null);}
    save(content: InteractionDraftContent): void {
        this.desired = structuredClone(content);
        this.tail = this.tail.then(() => this.persist());
    }
    async flush(): Promise<InteractionDraftRecord | undefined> {
        await this.tail; if (this.failed) throw this.failed.error; return this.record && structuredClone(this.record);
    }
    async retry(): Promise<void> {
        this.tail = this.tail.then(async () => {
            const failed = this.failed;
            if (failed) {
                try {this.record = await this.storage.write(failed.change); this.failed = undefined; this.report();}
                catch (error) {failed.error = error; this.report(error); return;}
            }
            await this.persist();
        });
        await this.flush();
    }
    async clear(expected: InteractionDraftRecord | undefined): Promise<void> {
        if (!expected) return;
        await this.tail;
        // A completed answer cannot consume edits created after its frozen draft.
        if (this.failed || this.record?.revision !== expected.revision || this.record.editId !== expected.editId) return;
        const change = {scope: this.scope, expectedRevision: expected.revision, editId: randomUUID(), content: null};
        this.desired = null;
        try {this.record = await this.storage.write(change);}
        catch (error) {this.failed = {change, error}; this.report(error); throw error;}
    }
    private report(error?: unknown): void {try {this.observer(error);} catch { /* Observation never changes storage facts. */ }}
    private async persist(): Promise<void> {
        if (this.failed || canonicalJson(this.record?.content ?? null) === canonicalJson(this.desired)) return;
        const change = {scope: this.scope, expectedRevision: this.record?.revision ?? null, editId: randomUUID(), content: structuredClone(this.desired)};
        try {this.record = await this.storage.write(change); this.report();}
        catch (error) {this.failed = {change, error}; this.report(error);}
    }
}
