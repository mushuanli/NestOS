import { expect, it, vi } from 'vitest';
import type { FlowDraft, FlowId } from '@itookit/llm-flow/contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { installFlowLibrary, restoreFlowLibrary } from './library';

const template: FlowDraft = { id: 'custom' as FlowId, name: 'Host template', draftVersion: 1, updatedAt: 0, nodes: [], edges: [], layout: { nodes: {} } };

it('uses caller templates and protects them from command handlers', async () => {
    const execute = vi.fn(async (_command: string, value: FlowDraft) => { value.name = 'Mutated'; return value; });
    const commands = { execute } as unknown as ICommandBus;
    await installFlowLibrary(commands, [template]);
    expect(execute.mock.calls[0][0]).toBe(FlowCommand.DraftInstall);
    expect(await restoreFlowLibrary(commands, [template])).toBe(1);
    expect(execute.mock.calls[1][0]).toBe(FlowCommand.DraftRestore);
    expect(template.name).toBe('Host template');
});

it('installs nothing for an empty host catalog and counts only restored drafts', async () => {
    const execute = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(template);
    const commands = { execute } as unknown as ICommandBus;
    await installFlowLibrary(commands, []);
    expect(await restoreFlowLibrary(commands, [])).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(await restoreFlowLibrary(commands, [template, { ...template, id: 'second' as FlowId }])).toBe(1);
});
