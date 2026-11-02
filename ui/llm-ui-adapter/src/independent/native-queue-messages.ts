import type {ConversationInstructionQueue, ConversationSnapshot as NativeSnapshot} from '../contracts';
import {getLocale, t} from '@itookit/common';
import type {ChatMessage, ConversationSnapshot, OperationLedger} from '@itookit/llm-ui';


/** Queue edits change previews, never the immutable submitted input or its receipt. */
export function nativeQueueMessages(state: NativeSnapshot, operations: OperationLedger, conversationId: string): ConversationSnapshot['operationMessages'] {
    const queue = state.instructionQueue;
    if (!queue) return;
    const accepted = new Set(queue.acceptedIds), submissions = new Map(queue.submissions?.map(item => [item.id, item]));
    return operations.getSnapshot().filter(record => record.conversationId === conversationId && accepted.has(record.context.operationId))
        .flatMap<NonNullable<ConversationSnapshot['operationMessages']>[number]>(record => {
            const operationId = record.context.operationId, item = queue.items.find(item => item.id === operationId);
            if (item) return [{operationId, message: queueMessage(item, queue.revision)}];
            const sent = submissions.get(operationId);
            return sent?.turnId || sent?.commandId ? [] : [{operationId, message: null}];
        });
}

function queueMessage(item: ConversationInstructionQueue['items'][number], revision: number): ChatMessage {
    const failed = item.state === 'failed';
    return {id: `operation:${item.id}`, revision, role: 'user', state: failed ? 'failed' : 'pending', timestamp: item.createdAt,
        parts: [{id: 'text', kind: 'markdown', text: item.text},
            {id: 'status', kind: 'tool', name: item.state === 'dispatching' ? t(item.acceptedAt ? 'session.instructions.acceptedAt' : 'session.instructions.dispatchedAt') : t(`session.instructions.${item.state}`),
                summary: queueSummary(item),
                state: failed ? 'failed' : item.state === 'dispatching' ? 'running' : 'pending'},
            ...(item.files.length ? [{id: 'files', kind: 'json' as const, label: t('session.instructions.attachments'), value: item.files.map(file => file.name)}] : [])]};
}

function queueSummary(item: ConversationInstructionQueue['items'][number]): string {
    if (item.error) return item.error === 'HARNESS_SESSION_BUSY' ? t('chat.submission.occupied') : item.error;
    const accepted = new Date(item.acceptedAt ?? NaN);
    if (Number.isFinite(accepted.getTime()) && accepted.getTime() > 0)
        return `${t('session.instructions.acceptedAt')} · ${accepted.toLocaleString(getLocale(), {hour12: false})}`;
    return item.state === 'pending' ? t('session.instructions.hint') : '';
}
