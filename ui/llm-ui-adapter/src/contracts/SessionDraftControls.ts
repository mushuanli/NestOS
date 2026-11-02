import type {IEditor} from '@itookit/ui-common-adapter';
import type {EditorFactory} from '@itookit/ui-common-adapter';

export interface SessionDraftMaterialization {
    container: HTMLElement;
    agentId?: string;
    title?: string;
    harness?: {profileId: string; expectedProject?: {nodeConnectionId: string; serverProjectId: string}; selection?: {modelId: string; reasoningEffort?: string}};
    /** The stable view creates its controller from host-prepared resource options. */
    createEditor?: EditorFactory;
}

/** Presentation preferences stay opaque to project navigation and persistence. */
export interface SessionDraftPreferences {
    readonly agentId?: string;
    readonly settings?: Readonly<Record<string, unknown>>;
}

/** Host owns draft lifecycle; the composer only saves input and requests a target. */
export interface SessionDraftControls<TSubmission = unknown> {
    readonly locked?: boolean;
    readonly id?: string;
    /** Materialize a controller inside the existing mount while retaining its composer. */
    readonly inPlace?: boolean;
    readonly executorScope?: 'local' | 'remote';
    /** Supports NestOS prompt targets on a separately selected native harness. */
    readonly promptHarness?: boolean;
    readonly scope?: {
        id: string; label: string;
        choices(): Promise<Array<{id: string; label: string; disabled?: boolean}>>;
        select(id: string, agentId?: string, preferences?: SessionDraftPreferences): Promise<void>;
        move?(id: string): Promise<void>;
    };
    readonly presentation?: {
        titleChanged(title: string): void;
    };
    readonly attachments?: {
        put(content: ArrayBuffer): Promise<string>;
        read(id: string): Promise<ArrayBuffer>;
    };
    readonly initialData?: string;
    refresh?(): Promise<SessionDraftControls<TSubmission> | undefined>;
    save?(data: string): Promise<void>;
    clear?(): Promise<void>;
    materialize(request?: SessionDraftMaterialization): Promise<{ editor: IEditor; resumeOnly: boolean; submission?: TSubmission }>;
}
