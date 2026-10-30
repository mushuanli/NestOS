import {createModuleLogger} from '@itookit/common';
import {hasConnectionCredentials, resolveChatModelForTier, type IConnectionReader} from '@itookit/kernel-adapters/contracts';
import {generateInSession} from './text-session';
import type {LocalApplicationServices} from '@itookit/app-contracts/services';
import type {ApplicationBackend} from '@itookit/app-contracts/services';
const log = createModuleLogger('text-generation');
function fail(code: string): never {throw Object.assign(new Error(code), {code});}
/** Draft generation is recorded in the caller-owned durable Session. */
export function createTextGeneration(services: LocalApplicationServices): Pick<ApplicationBackend, 'generateText' | 'cancelTextGeneration'> & {dispose(): Promise<void>} {
    const pending = new Map<string, AbortController>(), cancelled = new Set<string>();
    const completions = new Set<Promise<void>>();
    let disposed = false;
    return {dispose: async () => {disposed = true; for (const controller of pending.values()) controller.abort(); cancelled.clear(); await Promise.all(completions);}, generateText: async request => {
        if (disposed) fail('TEXT_CANCELLED');
        if (!request || typeof request.operationId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(request.operationId)) fail('TEXT_REQUEST_INVALID');
        const {operationId} = request, started = Date.now(); let stage = 'validate';
        if (pending.has(operationId)) fail('TEXT_REQUEST_BUSY');
        if (cancelled.delete(operationId)) fail('TEXT_CANCELLED');
        const controller = new AbortController(); pending.set(operationId, controller);
        let complete!: () => void; const completion = new Promise<void>(resolve => {complete = resolve;}); completions.add(completion);
        try {
            const content = await generateDraft(services, request, controller.signal, value => {stage = value;});
            log.info('text.generate', {operationId, sessionId: request.sessionId, stage, result: 'success', durationMs: Date.now() - started}); return content;
        } catch (error) {
            const raw = (error as {code?: unknown})?.code;
            const code = controller.signal.aborted ? 'TEXT_CANCELLED' : generationError(error, raw);
            log.warn('text.generate', {operationId, sessionId: request.sessionId, stage, result: 'failure', code, durationMs: Date.now() - started}); return fail(code);
        } finally {pending.delete(operationId); completions.delete(completion); complete();}
    }, cancelTextGeneration: async operationId => {
        if (pending.has(operationId)) pending.get(operationId)!.abort();
        else {cancelled.add(operationId); if (cancelled.size > 128) cancelled.delete(cancelled.values().next().value!);}
    }};
}
type TextRequest = Parameters<ApplicationBackend['generateText']>[0];
async function generateDraft(services: LocalApplicationServices, request: TextRequest,
    signal: AbortSignal, stage: (value: string) => void): Promise<string> {
    for (const value of [request.prompt, request.source, request.previousDraft]) if (typeof value !== 'string' || value.length > 1_000_000) fail('TEXT_INPUT_TOO_LARGE');
    if (!request.prompt.trim()) fail('TEXT_PROMPT_REQUIRED');
    if (request.connectionId !== undefined && (typeof request.connectionId !== 'string' || !request.connectionId.trim())) fail('TEXT_MODEL_UNAVAILABLE');
    stage('resolve-model'); const {connection, model} = await resolveTextModel(services.agentService, request.connectionId, request.modelId);
    signal.throwIfAborted(); stage('session-execution');
    if (!request.sessionId) fail('TEXT_SESSION_REQUIRED');
    log.info('text.execution', {operationId: request.operationId, sessionId: request.sessionId, stage: 'session-submit', result: 'ready', model: model.id, outputPolicy: 'session-default'});
    return generateInSession(services, request, connection.id, model.id, signal);
}

async function resolveTextModel(agents: IConnectionReader, id?: string, modelId?: string) {
    const connection = id ? await agents.getConnection(id) : await agents.getDefaultConnection('chat');
    if (!connection) return fail(id ? 'TEXT_MODEL_UNAVAILABLE' : 'TEXT_MODEL_UNCONFIGURED');
    if (connection.enabled === false) return fail('TEXT_CONNECTION_DISABLED');
    if (!hasConnectionCredentials(connection)) return fail('TEXT_CREDENTIALS_MISSING');
    const provider = agents.getProvider(connection.providerId);
    if (modelId !== undefined && (typeof modelId !== 'string' || !modelId.trim())) fail('TEXT_MODEL_UNAVAILABLE');
    const model = modelId ? provider?.models.find(item => item.id === modelId && (item.category ?? 'chat') === 'chat')
        : provider && resolveChatModelForTier(connection, provider, 'standard');
    if (!provider || provider.enabled === false || !model) return fail('TEXT_MODEL_UNAVAILABLE');
    return {connection, model};
}

function generationError(error: unknown, raw: unknown): string {
    if (typeof raw === 'string' && /^TEXT_[A-Z_]+$/.test(raw)) return raw;
    const value = error as {status?: number; statusCode?: number; name?: string};
    const status = value?.status ?? value?.statusCode;
    if (status === 401 || status === 403) return 'TEXT_AUTH_REJECTED';
    if (status === 429) return 'TEXT_RATE_LIMITED';
    if (value?.name === 'TimeoutError' || raw === 'ETIMEDOUT') return 'TEXT_PROVIDER_TIMEOUT';
    return 'TEXT_PROVIDER_FAILED';
}

/** Availability is checked again at generation time; UI choices are not authorization. */
export async function listTextModels(agents: IConnectionReader): ReturnType<ApplicationBackend['listTextModels']> {
    const [connections, selected] = await Promise.all([agents.getConnections(), agents.getDefaultConnection('chat')]);
    return connections.map(connection => {
        const provider = agents.getProvider(connection.providerId);
        const model = provider && resolveChatModelForTier(connection, provider, 'standard');
        const models = provider?.models.filter(item => (item.category ?? 'chat') === 'chat').map(item => ({id:item.id, name:item.name || item.id})) ?? [];
        const reason = connection.enabled === false ? 'TEXT_CONNECTION_DISABLED' : !hasConnectionCredentials(connection) ? 'TEXT_CREDENTIALS_MISSING'
            : !provider || provider.enabled === false || !models.length ? 'TEXT_MODEL_UNAVAILABLE' : undefined;
        return {id: connection.id, name: connection.name, model: model?.id, models, available: !reason, reason, default: connection.id === selected?.id};
    });
}
