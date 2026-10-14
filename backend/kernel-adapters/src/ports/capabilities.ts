import type { ISkillService, SkillDefinition, SkillLoadResult, SkillScopeLevel, SkillToolBinding } from '@itookit/tools/contracts';
import type { ToolHandler } from '@itookit/tools/contracts';
import type { EffectExecutionContext } from '@itookit/durable-kernel';

export type CapabilityResolver<T> = (
    context: EffectExecutionContext,
) => T | Promise<T>;

export type CapabilitySource<T> = T | CapabilityResolver<T>;

export interface SkillScopeSnapshot {
    cwd: string;
    agentInstructions: string;
    skills: SkillDefinition[];
}

export interface SkillSource {
    loadScope(cwd: string): Promise<SkillScopeSnapshot>;
    loadDirectory?(
        dirPath: string,
        scopeLevel: SkillScopeLevel,
        scopeRoot: string,
    ): Promise<SkillDefinition[]>;
}

export interface SkillToolHandlerFactory {
    create(skill: SkillDefinition, binding: SkillToolBinding): ToolHandler | undefined;
}

export interface SessionCapabilityScope {
    resolveMCPToolIds?(profiles: string[]): Promise<string[]>;
    prepareTools?(ids: string[]): Promise<void>;
    readonly toolService: import('@itookit/tools/contracts').IToolService;
    readonly skillService: ISkillService;
    dispose(): Promise<void>;
}

export interface SessionCapabilityRegistry {
    get(sessionId: string): Promise<SessionCapabilityScope>;
    /** Host-routed metadata lookup, without restoring Skills before an unload. */
    getForEffect?(context: EffectExecutionContext): Promise<SessionCapabilityScope>;
    /** Restore persisted loaded identities once per live scope, before building prompts or Effects. */
    restore(sessionId: string, loadedSkillIds: unknown): Promise<SessionCapabilityScope>;
    disposeSession(sessionId: string): Promise<void>;
    dispose(): Promise<void>;
}

export function resolveCapability<T>(
    source: CapabilitySource<T>,
    context: EffectExecutionContext,
): Promise<T> {
    return Promise.resolve(typeof source === 'function'
        ? (source as CapabilityResolver<T>)(context)
        : source);
}

export function failedSkillLoad(skillId: string, error: string): SkillLoadResult {
    return { skillId, success: false, toolIds: [], error };
}
