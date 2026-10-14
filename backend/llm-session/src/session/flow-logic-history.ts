import { t, type SessionTextKey } from '../utils/host-ports';
import type { FlowLogicEvent } from '@itookit/llm-flow/contracts';
import type { FlowInteraction } from '../contracts';
import type { EventEnvelope, TaskRecord } from '@itookit/durable-kernel';
import { flowActor } from './flow-identity';

/** Both live history and read-only recovery consume the same durable phase event. */
export function flowLogicInteraction(task: TaskRecord, event: EventEnvelope, translate: (key: SessionTextKey) => string = t): FlowInteraction | undefined {
    if (event.type !== 'flow.logic.completed') return undefined;
    const data = event.payload as FlowLogicEvent;
    if (!data || !['aggregate', 'judge'].includes(data.phase)) return undefined;
    const result = data.result as { stopReason?: string };
    const reason = result?.stopReason;
    const heading = reason === 'condition_met' ? translate('flow.history.conditionMet')
        : reason === 'max_rounds' ? translate('flow.history.roundLimit') : reason === 'continue' ? translate('flow.history.continue') : '';
    return { id: `flow-${task.id}-logic-${data.phase}-${data.round}`, taskId: task.id,
        name: `${data.name} · ${data.round}`, role: 'assistant', status: 'success',
        actor: { ...flowActor(task), nodeId: data.nodeId, nodeName: data.name, round: data.round },
        content: `${heading ? heading + '\n\n' : ''}\`\`\`json\n${JSON.stringify(data.result, null, 2)}\n\`\`\``,
        createdAt: event.occurredAt };
}
