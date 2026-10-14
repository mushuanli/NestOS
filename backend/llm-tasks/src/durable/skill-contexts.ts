import type { SkillDefinition } from '@itookit/tools/contracts';
import type { ToolDefinition } from '@itookit/llm-context';
import type { DurableAgentInput } from './types';

/** One activated Skill snapshot, exactly the shape a runtime `load_skill` result carries. */
export type SkillContext = NonNullable<DurableAgentInput['skillContexts']>[number];

/**
 * Snapshots for Skills selected at initialization. This mirrors the runtime `load_skill`
 * binding so both paths activate identically: only Skills that were actually selected and
 * are model-visible produce a snapshot, and a Skill tool is exposed only when it is both
 * declared by the Skill and inside the caller's capability set (`allowedToolIds`), with
 * `external` taken from the host catalog. No path here widens capabilities.
 */
export function buildSkillContexts(
    skills: SkillDefinition[],
    catalog: { definitions: ToolDefinition[]; externalIds: string[] },
    allowedToolIds: string[],
    selectedIds: ReadonlySet<string>,
): SkillContext[] {
    const allowed = new Set(allowedToolIds);
    const byName = new Map(catalog.definitions.map(definition => [toolNameOf(definition), definition]));
    const external = new Set(catalog.externalIds);
    return skills
        .filter(skill => selectedIds.has(skill.id) && skill.enabled && !skill.disableModelInvocation
            && skill.triggerStrategy !== 'action')
        .map(skill => ({
            skillId: skill.id,
            compactInstructions: skill.compact?.rawContent ?? '',
            tools: (skill.tools ?? []).flatMap(binding => {
                const name = binding.definition?.function?.name ?? binding.definition?.name ?? binding.toolId;
                const definition = byName.get(name);
                return definition && allowed.has(binding.toolId)
                    ? [{ toolId: binding.toolId, definition: structuredClone(definition), external: external.has(binding.toolId) }]
                    : [];
            }),
        }));
}

/** Read either supported ToolDefinition name shape. */
function toolNameOf(tool: ToolDefinition): string {
    return tool.function?.name ?? tool.name ?? '';
}
