// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { SkillSettingsEditor } from '../../llm-settings-ui/src/editors/SkillSettingsEditor';
import type { LLMSkill } from '@itookit/kernel-adapters/contracts';

// Use the editor's YAML dependency; this integration harness lives with app-shell's DOM tests.
const yaml = createRequire(resolve(process.cwd(), '../llm-settings-ui/package.json'))('js-yaml');

it('round trips supporting files and hidden fields through the real form-only editor lifecycle', async () => {
    const first: LLMSkill = { id: 'review', name: 'Review', description: '', type: 'prompt', enabled: true,
        instructions: 'Review', tools: [{ toolId: 'inspect', executionType: 'builtin', definition: { name: 'inspect' } }],
        triggerPatterns: ['review'], autoLoad: false, priority: 50, fsRoot: '/workspace/skills/review',
        referencePaths: ['ref.md', 'quote"<file>.md'], templatePath: 'template.md',
        correctionLog: { root: '/workspace', path: 'docs/corrections.md', enabled: false },
        compact: { marker: 'Compact Instructions', rawContent: 'Preserve checks', redLines: [] }, taskProgram: { kind: 'review', version: '1' } };
    const second: LLMSkill = { ...first, id: 'second', name: 'Second', tools: [{ toolId: 'search', executionType: 'builtin', definition: { name: 'search' } }],
        triggerPatterns: ['second'], compact: { marker: 'Second Compact', rawContent: 'Keep second', redLines: [] },
        taskProgram: { kind: 'second', version: '2' } };
    let skills = [first, second];
    const saveSkill = vi.fn(async () => {});
    const service = { getSkills: async () => skills, saveSkill };

    const container = document.createElement('div');
    const editor = SkillSettingsEditor.createFormOnly(container, service as never, {
        target: { kind: 'entity', entityType: 'skill', id: first.id },
    });
    await editor.init(container);

    const val = (name: string) => container.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value ?? '';
    const chk = (name: string) => container.querySelector<HTMLInputElement>(`[name="${name}"]`)?.checked ?? false;
    expect(val('correctionLog')).toBe('docs/corrections.md');
    expect(chk('correctionEnabled')).toBe(false);
    expect(val('referencePaths').split('\n')).toEqual(first.referencePaths);

    const initial = yaml.load(editor.getText()) as LLMSkill;
    expect(initial).toMatchObject({
        tools: first.tools,
        triggerPatterns: first.triggerPatterns,
        compact: first.compact,
        taskProgram: first.taskProgram,
    });

    container.querySelector<HTMLInputElement>('[name="fsRoot"]')!.value = '/workspace/shared';
    container.querySelector<HTMLInputElement>('[name="referencePaths"]')!.value = ' one.md\n\n two.md ';
    container.querySelector<HTMLInputElement>('[name="templatePath"]')!.value = ' new-template.md ';

    const dumped = yaml.load(editor.getText()) as LLMSkill;
    const preserved = { fsRoot: '/workspace/shared', referencePaths: ['one.md', 'two.md'], templatePath: 'new-template.md',
        correctionLog: first.correctionLog, tools: first.tools, triggerPatterns: first.triggerPatterns, compact: first.compact, taskProgram: first.taskProgram };
    expect(dumped).toMatchObject(preserved);

    container.querySelector<HTMLInputElement>('[name="fsRoot"]')!.dispatchEvent(new Event('input', { bubbles: true }));
    await editor.flushPendingSave();
    expect(saveSkill).toHaveBeenCalledWith(expect.objectContaining(preserved));

    container.querySelector<HTMLInputElement>('[name="correctionLog"]')!.value = '';
    const cleared = yaml.load(editor.getText()) as LLMSkill;
    expect(cleared.correctionLog).toBeUndefined();

    // Re-rendering another skill must replace the hidden-field snapshot.
    editor.selectedId = second.id;
    await editor.render();
    const switched = yaml.load(editor.getText()) as LLMSkill;
    expect(switched).toMatchObject({
        tools: second.tools,
        triggerPatterns: second.triggerPatterns,
        compact: second.compact,
        taskProgram: second.taskProgram,
    });

    // Re-rendering the same skill must not drop hidden fields.
    await editor.render();
    const rerendered = yaml.load(editor.getText()) as LLMSkill;
    expect(rerendered).toMatchObject({
        tools: second.tools,
        triggerPatterns: second.triggerPatterns,
        compact: second.compact,
        taskProgram: second.taskProgram,
    });
    await editor.destroy();
});
