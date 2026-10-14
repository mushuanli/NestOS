import type { ISkillService } from './skill-service';
import type { ISubAgentRouter } from './sub-agent';

/** Only the Skill loading operation used by the built-in tool. */
export type SkillLoaderPort = {
    loadSkill(id: string): Promise<Pick<Awaited<ReturnType<ISkillService['loadSkill']>>, 'success' | 'toolIds' | 'error'>>;
};

/** Only the delegation operation used by the built-in tool. */
export type AgentDelegationPort = {
    delegate(task: Pick<Parameters<ISubAgentRouter['delegate']>[0], 'instruction' | 'allowedTools' | 'maxRounds' | 'cwd'>):
        Promise<Pick<Awaited<ReturnType<ISubAgentRouter['delegate']>>, 'success' | 'summary' | 'rounds' | 'tokenUsage'>>;
};
