import { skillIndexPrompt, validateSkillIndexLimit } from './index-prompt';
import type { ISkillService, SkillLoadResult } from '@itookit/tools/contracts';
import { rollbackFailedLoad } from './loaded-state';

/** Build a new-run snapshot through the Session service; this does not grant tools. */
export async function buildSkillPromptContext(service: ISkillService, options: {
    userMessage?: string; onAutoLoaded?: (skillId: string) => Promise<void>; indexByteLimit?: number;
} = {}): Promise<{
    projectInstructions: string; skillInstructions: string; skillIndex: string;
}> {
    const indexByteLimit = options.indexByteLimit ?? 8192;
    validateSkillIndexLimit(indexByteLimit);
    const refreshed = await service.refreshScopedSkills();
    const failed = refreshed.find(result => !result.success);
    if (failed) throw new Error(failed.error ?? `Failed to refresh Skill: ${failed.skillId}`);
    refreshed.push(...await loadAutomaticSkills(service, options));
    const layers = service.getRouteLayers();
    const instructions: string[] = [];
    for (const skill of [...layers.dynamicMount, ...layers.spatial]) {
        const loaded = refreshed.find(result => result.skillId === skill.id && result.instructions !== undefined)
            ?? await service.loadSkill(skill.id);
        if (!loaded.success) throw new Error(loaded.error ?? `Failed to load Skill: ${skill.id}`);
        instructions.push(`Skill ${skill.id}:\n${loaded.instructions ?? skill.instructions}`);
        if (loaded.compactInstructions) instructions.push(`Skill ${skill.id} — critical rules:\n${loaded.compactInstructions}`);
    }
    return {
        projectInstructions: service.getAgentMdContent(),
        skillInstructions: instructions.join('\n\n'),
        skillIndex: skillIndexPrompt(layers.index, indexByteLimit),
    };
}

async function loadAutomaticSkills(service: ISkillService, options: {
    userMessage?: string; onAutoLoaded?: (skillId: string) => Promise<void>;
}): Promise<SkillLoadResult[]> {
    if (options.userMessage === undefined) return [];
    const matched = new Set(service.semanticMatchSkills(options.userMessage));
    const loaded = new Set(service.getLoadedSkills().map(skill => skill.id));
    const candidates = service.getScopedSkills().filter(skill => skill.enabled && !skill.disableModelInvocation
        && skill.triggerStrategy !== 'action' && !loaded.has(skill.id) && (skill.autoLoad || matched.has(skill.id)))
        .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    const results: SkillLoadResult[] = [];
    for (const skill of candidates) {
        const result = await service.loadSkill(skill.id);
        if (!result.success) throw new Error(result.error ?? `Failed to load Skill: ${skill.id}`);
        try { await options.onAutoLoaded?.(skill.id); }
        catch (error) { await rollbackFailedLoad(service, skill.id, error); }
        results.push(result);
    }
    return results;
}
