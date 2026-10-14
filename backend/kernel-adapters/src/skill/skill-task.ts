import type { SkillDefinition } from '@itookit/tools/contracts';
import type { JsonValue, RetryPolicy, TaskSpec } from '@itookit/durable-kernel';

export interface SkillTaskInput<T extends JsonValue = JsonValue> {
    skillId: string;
    arguments: T;
}

export interface SkillTaskOptions {
    retry?: RetryPolicy;
    priority?: number;
    labels?: Record<string, string>;
    deferStart?: boolean;
}

export function createSkillTaskSpec<T extends JsonValue>(
    skill: SkillDefinition,
    args: T,
    options: SkillTaskOptions = {},
): TaskSpec<SkillTaskInput<T>> {
    const program = skill.taskProgram;
    if (!program?.kind.trim() || !program.version.trim()) {
        throw new Error(`Skill does not declare a valid TaskProgram: ${skill.id}`);
    }
    return {
        program: { ...program },
        input: { skillId: skill.id, arguments: args },
        retry: options.retry,
        priority: options.priority,
        labels: { ...options.labels, skillId: skill.id },
        deferStart: options.deferStart ?? true,
    };
}
