import type { SkillDefinition } from '@itookit/tools/contracts';

export interface SkillSourceDriver {
    getSkills(): Promise<readonly SkillDefinition[]>;
}

export interface KernelSkillCatalog {
    getSkillNames(): string[];
    saveSkill(skill: SkillDefinition): Promise<void>;
    deleteSkill(id: string): Promise<void>;
}

/**
 * Keeps Kernel's persisted Skill catalog in sync with the host LLM driver.
 * Shared by Web/Tauri bootstrap and the headless CLI.
 */
export async function syncSkillsToKernel(
    llmDriver: SkillSourceDriver,
    kernel: { skillCatalog: KernelSkillCatalog },
): Promise<void> {
    const skills = await llmDriver.getSkills();
    const kernelIds = new Set(kernel.skillCatalog.getSkillNames());

    for (const skill of skills) {
        await kernel.skillCatalog.saveSkill(skill);
        kernelIds.delete(skill.id);
    }

    for (const id of kernelIds) {
        await kernel.skillCatalog.deleteSkill(id);
    }
}
