import type { JsonValue } from '@itookit/llm-flow/contracts';

export const ContentTransferCommand = {
    Capture: 'session.content.capture', Resolve: 'session.content.resolve', CreateChild: 'session.content.create-child',
    ChildReceipt: 'session.content.child-receipt',
} as const;
export interface TransferMessage { id: string; roundId: string; role: 'user' | 'assistant'; text: string }
export interface TransferOutput { id: string; requestId: string; taskId: string; port: string; label: string; value: JsonValue }
export interface ContentCapture {
    id: string; sessionId: string; branch: string; head: string | null; createdAt: number;
    messages: TransferMessage[]; outputs: TransferOutput[];
}
export type TransferSelection =
    | { kind: 'latest' | 'conversation' | 'replies' | 'summary' }
    | { kind: 'selected'; messageIds: string[] }
    | { kind: 'output'; outputId: string }
    | { kind: 'text'; text: string };
export interface ContentTransfer {
    id: string; sessionId: string; captureId: string; branch: string; head: string | null; createdAt: number;
    selection: TransferSelection; messageIds: string[]; value: JsonValue;
    output?: Omit<TransferOutput, 'value'>;
}
export interface TransferReference { sessionId: string; id: string }
export interface ResolveTransferInput { sessionId: string; captureId: string; selection: TransferSelection }
export interface CreateChildInput { sessionId: string; requestId: string; title: string; transfer?: TransferReference }
/** Original creation facts only; created never grants current execution or navigation permission. */
export type ChildCreationReceipt = {parentSessionId: string; requestId: string} & (
    {status: 'unknown'} | {status: 'reserved' | 'created'; sessionId: string});


export function isTransferSelection(value: unknown): value is TransferSelection {
    if (!value || typeof value !== 'object') return false;
    const selection = value as TransferSelection;
    if (['latest', 'conversation', 'replies', 'summary'].includes(selection.kind)) return true;
    if (selection.kind === 'selected') return Array.isArray(selection.messageIds) && selection.messageIds.every(id => typeof id === 'string');
    if (selection.kind === 'output') return typeof selection.outputId === 'string';
    return selection.kind === 'text' && typeof selection.text === 'string';
}

export function isContentTransfer(value: unknown): value is ContentTransfer {
    if (!value || typeof value !== 'object') return false;
    const transfer = value as ContentTransfer;
    return ['id', 'sessionId', 'captureId', 'branch'].every(key => typeof (transfer as unknown as Record<string, unknown>)[key] === 'string')
        && (transfer.head === null || typeof transfer.head === 'string') && Number.isFinite(transfer.createdAt)
        && Array.isArray(transfer.messageIds) && transfer.messageIds.every(id => typeof id === 'string')
        && isTransferSelection(transfer.selection) && Object.hasOwn(transfer, 'value') && validJson(transfer.value);
}

function validJson(value: unknown): boolean {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(validJson);
    return typeof value === 'object' && Object.values(value).every(validJson);
}
