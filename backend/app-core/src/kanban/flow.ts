import type {FlowDraft, JsonValue} from '@itookit/llm-flow/contracts';
import template from '../presets/kanban-discovery.json';
import {requireValue} from './validation';

/** Explicit product resource, published by the existing Flow service. */
export function createKanbanDiscoveryFlow(agentId?: string, execution: 'local' | 'remote' = 'local'): FlowDraft {
    const draft = structuredClone(template) as unknown as FlowDraft;
    const config = draft.nodes[0].config as Record<string, JsonValue>;
    if (agentId) config.agentId = agentId;
    if (execution === 'remote') {
        requireValue(agentId, 'REMOTE_SCANNER_AGENT_REQUIRED');
        delete draft.connections; delete draft.defaultConnection; delete config.connectionId;
    }
    return draft;
}
