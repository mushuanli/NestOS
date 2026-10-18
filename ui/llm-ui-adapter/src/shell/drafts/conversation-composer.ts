import {randomUUID, t} from '@itookit/common';
import type {ConversationControls} from '@itookit/ui-common';
import type {IChatInputConfig} from '../../domain/ports/IChatInputPresenter';
import {DraftDataCodec} from './session-draft-data';

interface Submission {id?: string; base: string; version: number; kind?: 'message' | 'command'}
/** The editable draft and frozen submission have separate durable identities. */
export class ConversationComposer {
    private revision = '0';
    private uncertain?: {operationId: string; data: string};
    private pending?: Submission;
    private base = '';
    private version = 0;
    private conflict = false;
    private readonly codec: DraftDataCodec;
    private writes: Promise<void> = Promise.resolve();
    constructor(private readonly controls: ConversationControls) {
        this.codec = new DraftDataCodec({put: data => controls.putComposerAsset!(data), read: id => controls.readComposerAsset!(id)});
    }
    static create(controls: ConversationControls): ConversationComposer | undefined {
        return controls.readComposerDraft && controls.saveComposerDraft && controls.putComposerAsset && controls.readComposerAsset
            ? new ConversationComposer(controls) : undefined;
    }
    async restore() {
        await this.writes.catch(() => {});
        if (!await this.reconcileSave()) throw new Error(t('harness.unknown'));
        const state = await this.controls.readComposerDraft!(); this.revision = state.revision;
        const stored = state.data ? JSON.parse(state.data) : undefined;
        const marker = stored?.remoteSubmission;
        if (stored) {delete stored.remoteSubmission; delete stored.composerVersion;}
        this.base = stored ? JSON.stringify(stored) : '';
        this.version = state.data ? JSON.parse(state.data).composerVersion ?? 0 : 0;
        this.pending = marker ? {id: marker.id, base: marker.base ?? this.base, version: marker.version ?? this.version, kind: marker.kind} : undefined;
        const draft = await this.codec.decode(this.base);
        this.conflict = false;
        return {...draft, submission: this.pending ? this.restoredSubmission(draft.files) : undefined};
    }
    private restoredSubmission(files: File[]) {
        const frozen = JSON.parse(this.pending!.base), current = this.base ? JSON.parse(this.base) : {files: []};
        return {kind: this.pending!.kind ?? 'message', text: frozen.config.text as string, clearText: this.pending!.version === this.version,
            files: files.filter((_file, i) => frozen.files.some((old: {id: string; image?: {revision: number}}) =>
                old.id === current.files[i].id && old.image?.revision === current.files[i].image?.revision))};
    }
    get submissionId(): string | undefined {return this.pending?.id;}
    get hasSubmission(): boolean {return !!this.pending;}
    get conflicted(): boolean {return this.conflict;}
    async submit(config: IChatInputConfig, files: File[], id = randomUUID(), kind: 'message' | 'command' = 'message'): Promise<string> {
        if (this.pending) throw new Error(t('harness.unknown'));
        const encoded = this.codec.encode(config, files), pending: Submission = {id, base: '', version: 0, kind};
        void encoded.catch(() => {});
        this.pending = pending;
        try {await this.enqueue(async () => {
            let base: string;
            try {base = await encoded;} catch (error) {if (this.pending === pending) this.pending = undefined; throw error;}
            this.updateBase(base);
            pending.base = base; pending.version = this.version;
            return this.decorate(base);
        });} catch (error) {if (definitelyRejected(error) && this.pending === pending) this.pending = undefined; throw error;}
        return id;
    }
    accepted(): void {this.pending = undefined;}
    private updateBase(data: string): void {if (data !== this.base) {this.base = data; ++this.version;}}
    private decorate(data: string): string {
        this.updateBase(data);
        return JSON.stringify({...JSON.parse(data), composerVersion: this.version,
            ...(this.pending?.base ? {remoteSubmission: this.pending} : {})});
    }
    save(config: IChatInputConfig, files: File[]): Promise<void> {
        const encoded = this.codec.encode(config, files); void encoded.catch(() => {});
        return this.enqueue(async () => this.decorate(await encoded));
    }
    private enqueue(prepare: () => Promise<string>): Promise<void> {
        const work = this.writes.catch(() => {}).then(async () => this.write(await prepare()));
        this.writes = work; void work.catch(() => {}); return work;
    }
    private async reconcileSave(): Promise<boolean> {
        if (!this.uncertain) return true;
        const observed = await this.controls.readComposerDraft!().catch(() => undefined);
        if (!observed?.acceptedOperationIds.includes(this.uncertain.operationId)) return false;
        const matches = observed.data === this.uncertain.data; this.uncertain = undefined;
        if (!matches) {this.conflict = true; throw Object.assign(new Error('Composer changed in another view'), {code: 'ECONFLICT'});}
        this.revision = observed.revision; return true;
    }
    private async write(data: string): Promise<void> {
        if (!await this.reconcileSave()) throw new Error(t('harness.unknown'));
        const operationId = randomUUID();
        try {const saved = await this.controls.saveComposerDraft!(data, this.revision, operationId); this.revision = saved.revision;}
        catch (error) {
            const failure = error as {code?: string; remoteCode?: string};
            if ((failure?.code ?? failure?.remoteCode) === 'ECONFLICT') this.conflict = true;
            if (definitelyRejected(error)) throw error;
            this.uncertain = {operationId, data};
            if (!await this.reconcileSave()) throw error;
        }
    }
}
function definitelyRejected(error: unknown): boolean {
    const value = error as {code?: string; remoteCode?: string; outcome?: string};
    return value?.outcome === 'not-committed' || value?.outcome !== 'unknown'
        && ['ECONFLICT', 'EINVAL', 'EACCES', 'EFBIG'].includes(value?.code ?? value?.remoteCode ?? '');
}
