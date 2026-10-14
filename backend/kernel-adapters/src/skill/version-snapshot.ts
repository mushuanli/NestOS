import { sha256HexSync } from '@itookit/llm-context';
import { type SkillDefinition, type SkillVersionSnapshot } from '@itookit/tools/contracts';

/** Object key order and catalog timestamps do not define a Skill version. */
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
}

export function createSkillVersionSnapshot(definition: SkillDefinition, instructions: string,
    compactInstructions: string): SkillVersionSnapshot {
    const { createdAt: _created, modifiedAt: _modified, versionPolicy: _policy, ...content } = definition;
    const digest = sha256HexSync(JSON.stringify(canonical({ definition: content, instructions, compactInstructions })));
    return { format: 1, digest, definition: structuredClone(definition), instructions, compactInstructions,
        policy: definition.versionPolicy ?? 'require-reload' };
}

export function validateSkillVersionSnapshot(value: unknown): SkillVersionSnapshot {
    const snapshot = value as SkillVersionSnapshot | undefined;
    if (!snapshot || snapshot.format !== 1 || !snapshot.definition || typeof snapshot.definition.id !== 'string'
        || !snapshot.definition.id.trim() || !Array.isArray(snapshot.definition.tools)
        || typeof snapshot.instructions !== 'string' || typeof snapshot.compactInstructions !== 'string'
        || !['keep-old', 'require-reload'].includes(snapshot.policy)
        || snapshot.policy !== (snapshot.definition.versionPolicy ?? 'require-reload')
        || createSkillVersionSnapshot(snapshot.definition, snapshot.instructions, snapshot.compactInstructions).digest !== snapshot.digest) {
        throw new Error('Invalid loaded Skill version snapshot');
    }
    return structuredClone(snapshot);
}

export function snapshotLoadResult(snapshot: SkillVersionSnapshot): import('@itookit/tools/contracts').SkillLoadResult {
    return { skillId: snapshot.definition.id, success: true, toolIds: snapshot.definition.tools.map(tool => tool.toolId),
        instructions: snapshot.instructions, compactInstructions: snapshot.compactInstructions, snapshot: structuredClone(snapshot) };
}
