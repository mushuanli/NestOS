import { ENTITY_ICONS, FILE_BROWSER_ICONS, escapeHTML, randomUUID, t } from '@itookit/common';
import { MODEL_OPERATIONS, modelForOperation, type AgentDefinition, type IAgentManagementService, type ModelDefaults, type ModelOperation } from '@itookit/kernel-adapters/contracts';
import { SettingsValidationError } from '@itookit/ui-common';
import type { ConnectionMeta, LLMProvider } from '@itookit/driver-llm/contracts';

interface Catalog { connections: ConnectionMeta[]; providers: LLMProvider[]; defaults: ModelDefaults; }

export async function renderAgentModelDefaults(agent: AgentDefinition, service: IAgentManagementService): Promise<string> {
    const started = performance.now(), operationId = randomUUID();
    try {
        const [connections, defaults] = await Promise.all([service.getConnections?.() ?? [], service.getModelDefaults?.() ?? {}]);
        const catalog = { connections, defaults, providers: service.getProviders?.() ?? [] };
        return `<section class="agent-section" data-agent-model-defaults>
            <button type="button" class="agent-section__header" aria-expanded="true"><span class="agent-section__icon">${ENTITY_ICONS.llm}</span>
                <span class="agent-section__title">${t('agent.models.title')}</span><span class="agent-section__toggle">${FILE_BROWSER_ICONS.chevron}</span></button>
            <div class="agent-section__body"><p class="agent-form-help">${t('agent.models.hint')}</p>
                <div class="agent-form-grid">${MODEL_OPERATIONS.map(operation => modelRow(operation, agent.modelDefaults?.[operation], catalog)).join('')}</div>
            </div></section>`;
    } catch (error) {
        console.error('agent.models.read.failed', { operation: 'agent.models.read', operationId, stage: 'catalog', result: 'failure', code: 'AGENT_MODEL_CATALOG_READ_FAILED', durationMs: Math.round(performance.now() - started) });
        return `<section class="agent-section" data-agent-model-defaults><div class="agent-section__body"><p class="agent-form-help" role="alert">${escapeHTML(t('agent.models.loadFailed', { reason: error instanceof Error ? error.message : t('agent.execution.unavailable') }))}</p></div></section>`;
    }
}

function modelRow(operation: ModelOperation, selected: string | undefined, catalog: Catalog): string {
    const candidates = catalog.connections.filter(connection => modelForOperation(connection, provider(catalog, connection), operation));
    const inherited = catalog.connections.find(item => item.id === catalog.defaults[operation]);
    const inheritedLabel = inherited ? connectionLabel(inherited, operation, catalog) : t('agent.models.systemUnset');
    const missing = selected && !candidates.some(item => item.id === selected)
        ? `<option value="${escapeHTML(selected)}" selected data-unavailable="true">${escapeHTML(t('connection.unavailable', { id: selected }))}</option>` : '';
    return `<label class="agent-form-field"><span class="agent-form-label">${t(`modelDefaults.purpose.${operation}`)}</span>
        <select class="agent-form-select" name="agentModelDefault:${operation}" data-agent-model-operation="${operation}">
            <option value="">${escapeHTML(t('agent.models.inherit', { name: inheritedLabel }))}</option>${missing}
            ${candidates.map(connection => `<option value="${escapeHTML(connection.id)}" ${connection.id === selected ? 'selected' : ''}
                ${connection.enabled === false || provider(catalog, connection)?.enabled === false ? 'disabled data-unavailable="true"' : ''}>${escapeHTML(connectionLabel(connection, operation, catalog))}</option>`).join('')}
        </select></label>`;
}

function provider(catalog: Catalog, connection: ConnectionMeta): LLMProvider | undefined {
    return catalog.providers.find(item => item.id === connection.providerId);
}

function connectionLabel(connection: ConnectionMeta, operation: ModelOperation, catalog: Catalog): string {
    const model = modelForOperation(connection, provider(catalog, connection), operation);
    return [connection.name, model?.name || model?.id].filter(Boolean).join(' · ');
}

export function readAgentModelDefaults(root: HTMLElement, previous?: ModelDefaults): ModelDefaults | undefined {
    const fields = [...root.querySelectorAll<HTMLSelectElement>('[data-agent-model-operation]')];
    if (!fields.length) return previous;
    const defaults: ModelDefaults = {};
    for (const field of fields) {
        const operation = field.dataset.agentModelOperation as ModelOperation;
        const unavailable = field.selectedOptions[0]?.dataset.unavailable === 'true';
        field.setCustomValidity(unavailable ? t('agent.models.invalid', { name: t(`modelDefaults.purpose.${operation}`) }) : '');
        if (unavailable) throw new SettingsValidationError(field.validationMessage);
        if (field.value) defaults[operation] = field.value;
    }
    return Object.keys(defaults).length ? defaults : undefined;
}

export function bindAgentModelDefaults(root: HTMLElement): void {
    for (const select of root.querySelectorAll<HTMLSelectElement>('[data-agent-model-operation]')) {
        select.addEventListener('change', () => {
            if (select.selectedOptions[0]?.dataset.unavailable !== 'true') select.setCustomValidity('');
        });
    }
}
