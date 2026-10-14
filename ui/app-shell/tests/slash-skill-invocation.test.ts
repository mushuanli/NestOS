// @vitest-environment jsdom
// Regression: `/sk-<id>` must reach the Session Skill controls. The UI "可勾选加载" flag (`enabled`)
// is false for action/silent Skills by design, so the popup has to key off `definitionEnabled`;
// getting that wrong made the command invisible and the text fell through as an unknown command.
import { expect, it, vi } from 'vitest';
import { ChatInput } from '../../llm-ui/src/components/input/ChatInputView';
import { SlashCommandPlugin } from '../../llm-ui/src/components/input/plugins/SlashCommandPlugin';
import { buildSlashCallbacks } from '../../llm-ui/src/shell/SlashCommandRouter';
import type { SkillInfo } from '../../llm-ui/src/domain/types';

const actionSkill: SkillInfo = { id: 'review', name: 'Review', description: '', loaded: false,
    enabled: false, definitionEnabled: true, toolCount: 0 };

function harness(load: () => Promise<unknown>) {
    const container = document.createElement('div');
    const view = new ChatInput(container, {} as never);
    const sent: string[] = [];
    const callbacks = buildSlashCallbacks({
        chatInput: view,
        sendCommand: () => ({ run: (request: { text: string }) => { sent.push(request.text); } }),
        skills: {
            snapshot: () => [actionSkill],
            load,
            describe: async () => ({ name: 'Review', type: 'prompt', instructions: 'Do the direct thing.',
                triggerStrategy: 'action' as const, disableModelInvocation: false, enabled: true }),
            openPanel: () => {},
            refresh: () => {},
        },
    } as never);
    const plugin = new SlashCommandPlugin(callbacks);
    view.registerPlugin(plugin);
    return { sent, plugin };
}

it('executes /sk-<id> for an action Skill and sends the inlined instructions without loading it', async () => {
    const load = vi.fn(async () => { throw new Error('Skill review cannot be loaded as model context'); });
    const { sent, plugin } = harness(load);

    expect(plugin.onBeforeSend('/sk-review check it')).toBe(false);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0]).toContain('[Action: review]');
    expect(sent[0]).toContain('Do the direct thing.');
    expect(sent[0]).toContain('Task: check it');
    // The model-context gate refuses action Skills; the invocation must not call it at all.
    expect(load).not.toHaveBeenCalled();
});
