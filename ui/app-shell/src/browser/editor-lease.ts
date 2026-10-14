import type { IEditor } from '@itookit/ui-common';

/** Save failure retains every resource; concurrent disposal shares one completion. */
export class EditorLease {
    private disposal?: Promise<void>;
    constructor(private readonly editor: IEditor | undefined, private readonly release: () => Promise<void>) {}
    dispose(): Promise<void> {
        return this.disposal ??= this.disposeNow();
    }
    private async disposeNow(): Promise<void> {
        try { await Promise.resolve().then(() => this.editor?.destroy()); }
        catch (error) { this.disposal = undefined; throw error; }
        await this.release();
    }
}
