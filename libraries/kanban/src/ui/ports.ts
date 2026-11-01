import type {KanbanClient, KanbanExternalReference} from '../contracts';
export interface KanbanPresentation {
    text(key: string, values?: Record<string, string | number>): string;
    icons: {refreshView: string; more: string; close: string};
    log?(event: {operationId: string; stage: string; result: 'success' | 'failure'; code?: string; count?: number; durationMs: number}): void;
    referenceUrl?(path: string): string;
}
export interface KanbanUIOptions {
    service?: KanbanClient;
    sidebar: HTMLElement;
    editor: HTMLElement;
    presentation: KanbanPresentation;
    selected(path: string): void;
    openSession(id: string): Promise<void>;
    activated?(): void;
    executionReference?(sessionId: string, bindingId: string): KanbanExternalReference;
}
