export type InteractionKind = 'input' | 'approval';
export type ApprovalDecision = 'approved' | 'rejected';

export interface InteractionRequest<T = unknown> {
    id: string;
    kind: InteractionKind;
    prompt: string;
    payload?: T;
}

export interface InteractionRecord<T = unknown> extends InteractionRequest<T> {
    status: 'pending' | 'resolved' | 'cancelled';
    response?: T;
    requestedAt: number;
    resolvedAt?: number;
}

export interface InteractionResponse<T = unknown> {
    interactionId: string;
    value: T;
}
