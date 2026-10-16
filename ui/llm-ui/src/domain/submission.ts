/** Transient presentation only; the host owns persistence and execution receipts. */
export interface ChatSubmission {
    id: string;
    text: string;
    timestamp: number;
    state: 'submitting' | 'accepted' | 'failed' | 'unknown';
    messageId?: string;
    error?: string;
}
