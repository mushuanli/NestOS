// @file: llm-ui/shell/slash-skill-commands.test.ts
// Regression: the chat input must expose Session Skill slash commands. Before this wiring
// `/sk-<id>` never appeared (getSkills was absent) and `/skill` always answered with the
// "requires Agent Mode" hint, so an action Skill had no UI entry point at all.
import { expect, it, vi } from 'vitest';
import { buildSlashCallbacks, type SlashCommandRouterDeps, type SlashSkillCommands } from './SlashCommandRouter';
import type { SkillInvocation } from '../domain/types';

const skill = (id: string) => ({ id, name: `Name ${id}`, description: '', loaded: false, enabled: false, definitionEnabled: true, toolCount: 0 });

function harness(skills?: SlashSkillCommands) {
    const sent: string[] = [];
    const routes = { run: (request: { text: string }) => { sent.push(request.text); } };
    const deps = { sendCommand: () => routes, skills } as unknown as SlashCommandRouterDeps;
    return { deps, sent };
}

const invocation = (text: string): SkillInvocation => ({ skillId: 'review', args: {}, filePaths: [], globPatterns: [], text });

it('omits Skill slash commands when the host injects no Session Skill controls', () => {
    const callbacks = buildSlashCallbacks(harness().deps);
    expect(callbacks.getSkills).toBeUndefined();
    expect(callbacks.onSkill).toBeUndefined();
    expect(callbacks.onSkillInvoke).toBeUndefined();
});

it('lists, loads and invokes Skills through the injected Session controls', async () => {
    const load = vi.fn(async () => ['review']);
    const openPanel = vi.fn();
    const refresh = vi.fn();
    const describe = vi.fn(async () => ({ name: 'Name review', type: 'prompt', instructions: 'Body',
        triggerStrategy: 'reference' as const, enabled: true }));
    const { deps, sent } = harness({ snapshot: () => [skill('review')], load, describe, openPanel, refresh });
    const callbacks = buildSlashCallbacks(deps);

    expect(callbacks.getSkills?.()).toEqual([skill('review')]);

    await callbacks.onSkill?.('review');
    expect(load).toHaveBeenCalledWith('review');

    callbacks.onSkills?.();
    expect(openPanel).toHaveBeenCalledTimes(1);

    // The popup asks for a refresh before building `/sk-<id>` commands.
    callbacks.onSkillPickerOpen?.();
    expect(refresh).toHaveBeenCalledTimes(1);

    // A model-context Skill is loaded and invoked through the Skill prompt.
    await callbacks.onSkillInvoke?.(invocation('check it'));
    expect(load).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('[Skill: Name review]');
    expect(sent[0]).toContain('Task: check it');
});

it('inlines an action Skill into the user message instead of loading it', async () => {
    const load = vi.fn(async () => ['review']);
    const describe = vi.fn(async () => ({ name: 'Review', type: 'prompt', instructions: 'Do the direct thing.',
        triggerStrategy: 'action' as const, enabled: true }));
    const { deps, sent } = harness({ snapshot: () => [skill('review')], load, describe, openPanel: vi.fn(), refresh: vi.fn() });
    const callbacks = buildSlashCallbacks(deps);

    await callbacks.onSkillInvoke?.(invocation('check it'));

    // The model-context gate refuses action Skills, so they must never be loaded.
    expect(load).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('[Action: review]');
    expect(sent[0]).toContain('Do the direct thing.');
    expect(sent[0]).toContain('Task: check it');
});

it('resolves the send command lazily, so callbacks built before it exists still send', async () => {
    const sent: string[] = [];
    let command: { run: (request: { text: string }) => void } | undefined;
    // The editor registers input plugins before `initCommands()` creates SendMessageCommand.
    const deps = { sendCommand: () => command!, skills: undefined } as unknown as SlashCommandRouterDeps;
    const callbacks = buildSlashCallbacks(deps);
    command = { run: request => { sent.push(request.text); } };

    await callbacks.onBtw?.('status');
    expect(sent).toEqual(['status']);
});

it.each([false, undefined])('refuses stale popup invocation when the definition is unavailable (%s)', async enabled => {
    const load = vi.fn();
    const describe = vi.fn(async () => enabled === undefined ? undefined : {
        name: 'Review', type: 'prompt', instructions: 'Must not send', enabled,
    });
    const { deps, sent } = harness({ snapshot: () => [skill('review')], load, describe,
        openPanel: vi.fn(), refresh: vi.fn() });
    await expect(buildSlashCallbacks(deps).onSkillInvoke!(invocation('task'))).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
});
