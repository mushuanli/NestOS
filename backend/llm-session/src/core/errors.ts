export enum ConversationErrorCode {
    SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
    SESSION_BUSY = 'SESSION_BUSY',
    SESSION_INVALID = 'SESSION_INVALID',
    AGENT_NOT_FOUND = 'AGENT_NOT_FOUND',
    ABORTED = 'ABORTED',
    UNKNOWN = 'UNKNOWN',
}

export class ConversationError extends Error {
    constructor(
        public readonly code: ConversationErrorCode,
        message: string,
        public readonly cause?: unknown,
    ) {
        super(message, { cause });
        this.name = 'ConversationError';
    }

    static from(error: unknown): ConversationError {
        if (error instanceof ConversationError) return error;
        if (isAbortError(error)) {
            return new ConversationError(
                ConversationErrorCode.ABORTED,
                'Operation aborted',
                error,
            );
        }
        const message = error instanceof Error ? error.message : String(error);
        return new ConversationError(ConversationErrorCode.UNKNOWN, message, error);
    }
}

function isAbortError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return error.name === 'AbortError'
        || error.message.toLowerCase().includes('abort');
}
