import { createModuleLogger, randomUUID, t } from '@itookit/common';
import type { LLMProvider } from '@itookit/driver-llm/contracts';

const log = createModuleLogger('toolbox-provider');
const mutations = new WeakMap<object, Promise<string>>();
type ExistingProvider = Pick<LLMProvider, 'id' | 'name'>;
const normalizedName = (name: string): string => name.trim().toLocaleLowerCase();
const fields = ['implementation', 'baseURL', 'models', 'icon', 'credentialMode', 'connectionTestModel', 'media',
    'supportedProtocols', 'defaultProtocol', 'modelsPath', 'geminiPath', 'chatPath', 'defaultPath', 'anthropicPath',
    'responsesPath', 'authMethod', 'supportsThinking', 'requiresReferer', 'capabilities', 'responses', 'defaultTemperature'] as const;

/** Copy configuration fields only; credentials and runtime state never become templates. */
export class ProviderTemplates {
    private readonly templates: Map<string, LLMProvider>;
    constructor(templates: readonly LLMProvider[], private readonly current: () => readonly ExistingProvider[], private readonly owner: object = {}) {
        this.templates = new Map(templates.map(template => [template.id, {
            ...structuredClone(Object.fromEntries(fields.filter(key => template[key] !== undefined).map(key => [key, template[key]]))),
            id: template.id, name: template.name,
        } as LLMProvider]));
    }
    list(): Array<{id: string; name: string}> { return [...this.templates.values()].map(({id, name}) => ({id, name})); }
    async create(id: string, name: string, templateId: string | undefined, save: (provider: LLMProvider) => Promise<void>): Promise<string> {
        const previous = mutations.get(this.owner) ?? Promise.resolve('');
        const work = previous.catch(() => '').then(() => this.createNow(id, name, templateId, save));
        mutations.set(this.owner, work);
        try { return await work; }
        finally { if (mutations.get(this.owner) === work) mutations.delete(this.owner); }
    }
    private async createNow(id: string, name: string, templateId: string | undefined, save: (provider: LLMProvider) => Promise<void>): Promise<string> {
        const operationId = randomUUID(), started = performance.now(); let stage = 'validation';
        log.info('toolbox.provider.create.started', {operation: 'toolbox.provider.create', operationId, stage, fromTemplate: templateId !== undefined});
        try {
            const template = templateId === undefined ? undefined : this.templates.get(templateId);
            if (templateId !== undefined && !template) throw Object.assign(new Error(t('provider.template.missing')), {code: 'PROVIDER_TEMPLATE_MISSING'});
            if (this.current().some(provider => (template && provider.id === template.id) || normalizedName(provider.name) === normalizedName(name)))
                throw Object.assign(new Error(t('provider.template.exists')), {code: 'PROVIDER_ALREADY_EXISTS'});
            const provider: LLMProvider = template ? structuredClone(template) : {id, name, implementation: 'openai-compatible', baseURL: '', models: []};
            id = template?.id ?? id;
            stage = 'persistence';
            await save({...provider, id, name, isBuiltin: false, enabled: true});
            log.info('toolbox.provider.create.completed', {operation: 'toolbox.provider.create', operationId, stage, outcome: 'success', models: provider.models.length, durationMs: Math.round(performance.now() - started)});
            return id;
        } catch (error) {
            log.error('toolbox.provider.create.failed', {operation: 'toolbox.provider.create', operationId, stage, outcome: 'failure', code: stage === 'validation' ? (error as {code?: string}).code ?? 'PROVIDER_TEMPLATE_INVALID' : 'PROVIDER_SAVE_FAILED', durationMs: Math.round(performance.now() - started)});
            throw error;
        }
    }
}
