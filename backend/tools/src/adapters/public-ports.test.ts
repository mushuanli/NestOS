import { expect, it } from 'vitest';
import { createAgentTool, createSkillTool, ToolDeviceDriver } from '../index';
import type { AgentDelegationPort, SkillLoaderPort } from '../contracts';

it('loads a Skill using only an injected loading operation', async () => {
    const loader: SkillLoaderPort = {
        async loadSkill(id) { return { success: id === 'review', toolIds: ['Read'] }; },
    };
    const driver = new ToolDeviceDriver([createSkillTool(loader)]);
    await driver.init();
    const result = await driver.invoke({ toolId: 'Skill', args: { skill_id: 'review' } });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ skillId: 'review', loaded: true, toolIds: ['Read'] });
});

it('delegates using only an injected operation and passes the execution scope', async () => {
    const tasks: Parameters<AgentDelegationPort['delegate']>[0][] = [];
    const router: AgentDelegationPort = {
        async delegate(task) {
            tasks.push(task);
            return { success: true, summary: 'Reviewed', rounds: 1, tokenUsage: { input: 2, output: 3 } };
        },
    };
    const driver = new ToolDeviceDriver([createAgentTool(router)]);
    await driver.init();
    const result = await driver.invoke({ toolId: 'Agent', args: {
        instruction: 'Review files', allowed_tools: ['Read'], max_rounds: 2,
    }, cwd: '/workspace' });
    expect(result.success).toBe(true);
    expect(tasks).toEqual([{ instruction: 'Review files', allowedTools: ['Read'], maxRounds: 2, cwd: '/workspace' }]);
    expect(result.data).toMatchObject({ summary: 'Reviewed', tokenUsage: { input: 2, output: 3 } });
});
