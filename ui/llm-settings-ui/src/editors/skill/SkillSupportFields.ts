import type { LLMSkill } from '@itookit/kernel-adapters/contracts';

export function readSkillSupportFields(val: (name: string) => string, chk: (name: string) => boolean): Pick<LLMSkill, 'fsRoot' | 'referencePaths' | 'templatePath' | 'correctionLog'> {
    const path = val('correctionLog').trim();
    return {
        fsRoot: val('fsRoot').trim() || undefined,
        referencePaths: val('referencePaths').split('\n').map(value => value.trim()).filter(Boolean),
        templatePath: val('templatePath').trim() || undefined,
        correctionLog: path ? { path, root: val('correctionRoot').trim() || undefined, enabled: chk('correctionEnabled') } : undefined,
    };
}
