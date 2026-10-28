import type { DigitalTwinService } from '@itookit/app-contracts/services';
import { FSError } from '@itookit/vfs-core';

type Patch = Parameters<DigitalTwinService['configure']>[0];
export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed';

/** Serialize field patches; newer edits stay queued while a previous write is in flight. */
export class TwinSettingsAutosave {
    private edits: Patch = {};
    private timer?: ReturnType<typeof setTimeout>;
    private saving?: Promise<void>;
    state: SaveState = 'idle';
    error = '';
    constructor(private readonly service: DigitalTwinService, private readonly changed: () => void) {}
    get pending(): boolean { return Boolean(this.saving) || Object.keys(this.edits).length > 0; }
    edit(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, immediate: boolean): void {
        const name = control.name as keyof Patch;
        const value = control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked
            : name === 'monthlyTokenLimit' ? (control.value.trim() ? Number(control.value) : null)
            : name === 'tokenLimit' ? (control.value.trim() ? Number(control.value) : NaN)
            : ['userAliases', 'globalExclude'].includes(name) ? control.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : control.value.trim();
        Object.assign(this.edits, { [name]: value });
        this.update('pending'); clearTimeout(this.timer);
        if (immediate) void this.flush();
        else this.timer = setTimeout(() => { void this.flush(); }, 450);
    }
    async flush(): Promise<void> {
        clearTimeout(this.timer);
        if (this.saving) { await this.saving; return; }
        if (!Object.keys(this.edits).length) return;
        this.saving = this.drain().finally(() => { this.saving = undefined; });
        await this.saving;
    }
    private async drain(): Promise<void> {
        while (Object.keys(this.edits).length) {
            const patch = { ...this.edits }; this.update('saving');
            try { await this.save(patch); }
            catch (error) { this.update('failed', error instanceof Error ? error.message : String(error)); return; }
            for (const key of Object.keys(patch) as Array<keyof Patch>) {
                if (JSON.stringify(this.edits[key]) === JSON.stringify(patch[key])) delete this.edits[key];
            }
        }
        this.update('saved');
    }
    private async save(patch: Patch): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            try {
                const settings = await this.service.getSettings();
                await this.service.configure(patch, settings.revision); return;
            }
            catch (error) {
                const conflict = error instanceof FSError && error.code === 'ECONFLICT'
                    || error instanceof Error && /Twin (revision|condition revision) conflict/.test(error.message);
                if (attempt >= 2 || !conflict) throw error;
                await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
            }
        }
    }
    private update(state: SaveState, error = ''): void { this.state = state; this.error = error; this.changed(); }
}
