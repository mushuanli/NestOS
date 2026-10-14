// @vitest-environment jsdom
import { expect, it } from 'vitest';
import yaml from 'js-yaml';
import type { LLMSkill } from '@itookit/kernel-adapters/contracts';
import { SkillSettingsEditor } from '../src/editors/SkillSettingsEditor';

function parse(text: string): LLMSkill {
    return yaml.load(text) as LLMSkill;
}

it('preserves hidden fields through the form-only editor lifecycle', async () => {
    const first: LLMSkill = {
        id: 'review',
        name: 'Review',
        description: '',
        type: 'prompt',
        enabled: true,
        instructions: 'Review',
        tools: [{ toolId: 'inspect', executionType: 'builtin', definition: { name: 'inspect' } }],
        triggerPatterns: ['review'],
        autoLoad: false,
        priority: 50,
        compact: { marker: 'Compact Instructions', rawContent: 'Preserve checks', redLines: [] },
        taskProgram: { kind: 'review', version: '1' },
    };
    const second: LLMSkill = {
        ...first,
        id: 'second',
        name: 'Second',
        tools: [{ toolId: 'search', executionType: 'builtin', definition: { name: 'search' } }],
        triggerPatterns: ['second'],
        compact: { marker: 'Second Compact', rawContent: 'Keep second', redLines: [] },
        taskProgram: { kind: 'second', version: '2' },
    };
    let skills = [first, second];
    const service = { getSkills: async () => skills };

    const container = document.createElement('div');
    const editor = SkillSettingsEditor.createFormOnly(container, service as never, {
        target: { kind: 'entity', entityType: 'skill', id: first.id },
    });
    await editor.init(container);

    expect(parse(editor.getText())).toMatchObject({
        tools: first.tools,
        triggerPatterns: first.triggerPatterns,
        compact: first.compact,
        taskProgram: first.taskProgram,
    });

    editor.selectedId = second.id;
    await editor.render();
    expect(parse(editor.getText())).toMatchObject({
        tools: second.tools,
        triggerPatterns: second.triggerPatterns,
        compact: second.compact,
        taskProgram: second.taskProgram,
    });

    await editor.render();
    expect(parse(editor.getText())).toMatchObject({
        tools: second.tools,
        triggerPatterns: second.triggerPatterns,
        compact: second.compact,
        taskProgram: second.taskProgram,
    });

    skills = [];
    await editor.render();
    expect(editor.getText()).toBe('');
});
