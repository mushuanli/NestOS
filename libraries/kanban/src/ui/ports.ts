import type {KanbanClient, KanbanExternalReference} from '../contracts';
import type {ContentTitleBarParts} from '@itookit/ui-common';
export interface KanbanPresentation {
    text(key: string, values?: Record<string, string | number>): string;
    icons: {refreshView: string; more: string; close: string; back?: string};
    log?(event: {operationId: string; stage: string; result: 'success' | 'failure'; code?: string; count?: number; durationMs: number}): void;
    referenceUrl?(path: string): string;
}
export interface KanbanUIOptions {
    service?: KanbanClient;
    /** Omit when the host owns shared workspace navigation. */
    sidebar?: HTMLElement;
    editor: HTMLElement;
    presentation: KanbanPresentation;
    selected(path: string): void;
    openSession(id: string): Promise<void>;
    activated?(): void;
    mountNavigation?(container: HTMLElement): () => void;
    mountWindowList?(container: HTMLElement): () => void;
    mountTitleBar?(container: HTMLElement, parts: ContentTitleBarParts): () => void;
    initialResource?: string;
    navigate?(path: string): Promise<void>;
    changed?(): void;
    committed?(): void;
    executionReference?(sessionId: string, bindingId: string): KanbanExternalReference;
}
