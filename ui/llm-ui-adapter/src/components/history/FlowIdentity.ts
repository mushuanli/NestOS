import { escapeHTML, t } from '@itookit/common';
import { type FlowActor } from '@itookit/llm-session/contracts';
import type { ExecutionNode } from '@itookit/llm-session/contracts';

/** Role is presentation; provenance identifies the actual executor or tool owner. */
export function renderFlowIdentity(node: ExecutionNode): string {
    const actor = node.data.metaInfo?.actor as FlowActor | undefined;
    const kind = actor?.kind ?? 'node';
    const role = node.messageRole === 'user' ? t('flow.history.user')
        : kind === 'tool' ? t('flow.history.tool') : t('flow.history.assistant');
    const details = [
        actor?.nodeName && kind !== 'node' ? `${t('flow.history.node')}: ${actor.nodeName}` : '',
        actor?.agentId ? `Agent: ${actor.agentId}` : '',
        actor?.skillIds?.length ? `Skill: ${actor.skillIds.join(', ')}` : '',
        actor?.round !== undefined ? `${t('flow.history.round')}: ${actor.round}` : '',
        actor?.toolCallId ? `${t('flow.history.call')}: ${actor.toolCallId}` : '',
    ].filter(Boolean).join(' · ');
    const name = kind === 'input' ? t('flow.history.input') : kind === 'approval' ? t('flow.history.approval') : node.name;
    return `<span class="llm-ui-node__name" data-actor-kind="${escapeHTML(kind)}">${escapeHTML(role)} · ${escapeHTML(name)}</span>
        ${details ? `<small class="llm-ui-node__identity">${escapeHTML(details)}</small>` : ''}`;
}
