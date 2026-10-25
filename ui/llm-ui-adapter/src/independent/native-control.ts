import type {OperationReceipt} from '@itookit/llm-ui';
import type {ConversationSnapshot} from '@itookit/ui-common';

/** Control acknowledgement never supplies a user history message or consumes a draft. */
export function nativeControlReceipt(state: ConversationSnapshot, operationId: string, target?: string): OperationReceipt {
    const control = state.controls?.find(row => row.operationId === operationId && (!target || row.turnId === target));
    if (!control || control.receipt === 'unknown') return {status: 'unknown', operationId, message: 'Awaiting the original control receipt'};
    if (control.receipt === 'rejected') return {status: 'rejected', operationId, code: control.code ?? 'CONTROL_REJECTED', message: 'Native control was rejected'};
    return {status: 'accepted', operationId, submissionRef: control.turnId};
}
