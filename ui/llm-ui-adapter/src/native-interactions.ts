import type {ConversationRequest} from '@itookit/ui-common';
import type {InputField, InteractionResponse, InteractionView} from '@itookit/llm-ui';
import {t} from '@itookit/common';

export function nativeInteraction(request: ConversationRequest, revision = 0): InteractionView {
    const base = {id: `${typeof request.id}:${request.id}`, revision, state: 'pending' as const, responding: request.responding,
        title: request.title ?? t('harness.interaction'), detail: request.detail};
    if (request.kind === 'unsupported') return {...base, kind: 'unsupported'};
    if (request.kind === 'approval') return {...base, kind: 'approval', decisions: (request.decisions ?? ['accept', 'decline']).map(id => ({id, label: decisionLabel(id)}))};
    return {...base, kind: 'input', fields: (request.questions ?? []).map(questionField)};
}
function questionField(q: NonNullable<ConversationRequest['questions']>[number]): InputField {
    const base = {id: q.id, label: q.question, required: true};
    if (q.isSecret || !q.options?.length) return {...base, kind: 'text', secret: !!q.isSecret};
    const choices = q.options.map(option => ({id: option.label, label: option.label, description: option.description}));
    const other = q.isOther ? t('harness.otherAnswer') : undefined;
    return q.multiSelect ? {...base, kind: 'multi-choice', choices, min: 1, other} : {...base, kind: 'single-choice', choices, other};
}
export function nativeResponse(response: InteractionResponse): Record<string, unknown> {
    return response.kind === 'approval' ? {decision: response.decisionId}
        : {answers: Object.fromEntries(Object.entries(response.values).map(([id, value]) => [id, {answers: Array.isArray(value) ? value : [value]}]))};
}
function decisionLabel(id: string): string {
    if (id === 'accept') return t('harness.approve');
    if (id === 'acceptForSession') return t('harness.approveForSession');
    return t(id === 'cancel' ? 'harness.cancelInteraction' : 'harness.decline');
}
