import type {ChatMessage, MessagePart} from '@itookit/llm-ui';

/** Keep execution outcomes visible without changing backend execution facts. */
export function messageState(status?: string): ChatMessage['state'] {
    if (status === 'failed' || status === 'error') return 'failed';
    if (status === 'cancelled' || status === 'aborted') return 'cancelled';
    if (status === 'running' || status === 'streaming') return 'streaming';
    if (['pending', 'queued', 'paused', 'waiting_input'].includes(status ?? '')) return 'pending';
    return 'complete';
}

export function toolState(status?: string): Extract<MessagePart, {kind: 'tool'}>['state'] {
    const state = messageState(status);
    if (state === 'pending' || state === 'streaming') return 'running';
    return state === 'failed' || state === 'cancelled' ? 'failed' : 'succeeded';
}
