import type { IConnectionService, ModelPricingConfig, ConflictStrategy, ConflictItem, ImportStats, ConfigurationImportPort } from '@itookit/kernel-adapters/contracts';
import { toLLMProvider, toRuntimeConnection, toRuntimeAgent, getProviderDefs, type LLMConfigFile } from '@itookit/kernel-adapters/llm/config';

interface AgentStore {
    getAgents(): Promise<Array<{ id: string }>>;
    saveAgent(agent: unknown, options?: { onDuplicate?: 'merge' | 'error' }): Promise<void>;
    getSkills(): Promise<Array<{ id: string }>>;
    saveSkill(skill: unknown): Promise<void>;
}
type Kind = ConflictItem['type'];
interface ImportContext {
    service: IConnectionService;
    agents: AgentStore | null;
    strategy: ConflictStrategy;
    existing: Record<Kind, Set<string>>;
    names: Record<Kind, Map<string, string>>;
    stats: ImportStats;
}
function agentStore(service: IConnectionService): AgentStore | null {
    return 'saveAgent' in service ? service as unknown as AgentStore : null;
}
async function existingIds(service: IConnectionService): Promise<Record<Kind, Set<string>>> {
    const agents = agentStore(service);
    const [connections, definitions, skills] = await Promise.all([
        service.getConnections(), agents?.getAgents() ?? [], agents?.getSkills() ?? [],
    ]);
    const ids = (items: Array<{ id: string }>) => new Set(items.map(item => item.id));
    return { provider: ids(service.getProviders()), connection: ids(connections), agent: ids(definitions), skill: ids(skills) };
}
function definitions(config: LLMConfigFile) {
    return { provider: getProviderDefs(config), connection: config.connections ?? [], agent: config.agents ?? [], skill: config.skills ?? [] };
}
export async function detectConflicts(config: LLMConfigFile, service: IConnectionService): Promise<ConflictItem[]> {
    const existing = await existingIds(service), entries = definitions(config);
    return (Object.keys(entries) as Kind[]).flatMap(type => entries[type].filter(item => existing[type].has(item.id))
        .map(item => ({ type, id: item.id, name: item.name })));
}
function renamedIds(entries: Array<{ id: string }>, existing: Set<string>, strategy: ConflictStrategy): Map<string, string> {
    const result = new Map<string, string>();
    if (strategy !== 'rename') return result;
    const allocated = new Set([...existing, ...entries.map(entry => entry.id)]);
    for (const entry of entries) {
        if (!existing.has(entry.id)) continue;
        let suffix = 2;
        while (allocated.has(`${entry.id}-${suffix}`)) suffix++;
        const id = `${entry.id}-${suffix}`; allocated.add(id); result.set(entry.id, id);
    }
    return result;
}
async function context(config: LLMConfigFile, service: IConnectionService, strategy: ConflictStrategy): Promise<ImportContext> {
    const existing = await existingIds(service), entries = definitions(config);
    return { service, agents: agentStore(service), strategy, existing,
        names: { provider: renamedIds(entries.provider, existing.provider, strategy), connection: renamedIds(entries.connection, existing.connection, strategy),
            agent: renamedIds(entries.agent, existing.agent, strategy), skill: renamedIds(entries.skill, existing.skill, strategy) },
        stats: { providers: 0, connections: 0, agents: 0, skills: 0, skipped: 0 } };
}
function skipped(ctx: ImportContext, kind: Kind, id: string): boolean {
    const skip = ctx.strategy === 'skip' && ctx.existing[kind].has(id);
    if (skip) ctx.stats.skipped++;
    return skip;
}
async function importProviders(ctx: ImportContext, config: LLMConfigFile): Promise<void> {
    for (const entry of getProviderDefs(config)) {
        if (skipped(ctx, 'provider', entry.id)) continue;
        const previous = ctx.strategy === 'overwrite' ? await ctx.service.getFullProvider?.(entry.id) : undefined;
        await ctx.service.saveProvider(toLLMProvider({ ...entry, id: ctx.names.provider.get(entry.id) ?? entry.id,
            isBuiltin: false, apiKey: previous?.apiKey ?? entry.apiKey }));
        ctx.stats.providers++;
    }
}
async function importConnections(ctx: ImportContext, config: LLMConfigFile): Promise<void> {
    for (const entry of config.connections ?? []) {
        if (skipped(ctx, 'connection', entry.id)) continue;
        await ctx.service.saveConnection(toRuntimeConnection({ ...entry, id: ctx.names.connection.get(entry.id) ?? entry.id,
            providerId: ctx.names.provider.get(entry.providerId) ?? entry.providerId }));
        ctx.stats.connections++;
    }
}
async function importAgents(ctx: ImportContext, config: LLMConfigFile): Promise<void> {
    if (!ctx.agents) return;
    for (const entry of config.agents ?? []) {
        if (skipped(ctx, 'agent', entry.id)) continue;
        const connectionId = entry.config.connectionId;
        const config = typeof connectionId === 'string' ? { ...entry.config, connectionId: ctx.names.connection.get(connectionId) ?? connectionId } : entry.config;
        await ctx.agents.saveAgent(toRuntimeAgent({ ...entry, id: ctx.names.agent.get(entry.id) ?? entry.id, config }), { onDuplicate: 'error' });
        ctx.stats.agents++;
    }
}
async function importSkills(ctx: ImportContext, config: LLMConfigFile): Promise<void> {
    if (!ctx.agents) return;
    for (const entry of config.skills ?? []) {
        if (skipped(ctx, 'skill', entry.id)) continue;
        await ctx.agents.saveSkill({ ...entry, id: ctx.names.skill.get(entry.id) ?? entry.id }); ctx.stats.skills++;
    }
}
/** Backend owns import order, conflict allocation and credential preservation. */
export async function executeImport(config: LLMConfigFile, service: IConnectionService, strategy: ConflictStrategy): Promise<ImportStats> {
    if (!['skip', 'overwrite', 'rename'].includes(strategy)) throw new Error('Invalid configuration import strategy');
    const ctx = await context(config, service, strategy);
    await importProviders(ctx, config); await importConnections(ctx, config);
    await importAgents(ctx, config); await importSkills(ctx, config);
    if (config.pricing?.length && 'writePricing' in service) {
        const pricing = service as unknown as { writePricing(config: ModelPricingConfig): Promise<void> };
        await pricing.writePricing({ model_pricing: config.pricing });
    }
    return ctx.stats;
}
/** The host supplies one service-bound import port; the UI chooses only the user's strategy. */
export function withConfigurationImport<T extends IConnectionService>(service: T): T & ConfigurationImportPort {
    return new Proxy(service, { get(target, key) {
        if (key === 'previewConfigurationImport') return (config: LLMConfigFile) => detectConflicts(config, target);
        if (key === 'importConfiguration') return (config: LLMConfigFile, strategy: ConflictStrategy) => executeImport(config, target, strategy);
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
    } }) as T & ConfigurationImportPort;
}
