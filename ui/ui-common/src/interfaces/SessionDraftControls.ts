import type { IEditor } from './IEditor';

/** Host owns draft lifecycle; the composer only saves input and requests a target. */
export interface SessionDraftControls<TSubmission = unknown> {
    readonly attachments?: {
        put(content: ArrayBuffer): Promise<string>;
        read(id: string): Promise<ArrayBuffer>;
    };
    readonly initialData?: string;
    save?(data: string): Promise<void>;
    clear?(): Promise<void>;
    materialize(): Promise<{ editor: IEditor; resumeOnly: boolean; submission?: TSubmission }>;
}
