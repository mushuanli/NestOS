import { expect, it, vi } from 'vitest';
import type { FlowDraft, FlowId } from '@itookit/llm-flow/contracts';
import { FlowLibraryCommand } from '@itookit/app-contracts';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { restoreFlowLibrary } from './library';

const template: FlowDraft = { id: 'custom' as FlowId, name: 'Host template', draftVersion: 1, updatedAt: 0, nodes: [], edges: [], layout: { nodes: {} } };

it('delegates recovery policy to the application and protects caller templates', async () => {
    const execute = vi.fn(async (_command: string, value: { templates: FlowDraft[] }) => { value.templates[0].name = 'Mutated'; return 1; });
    const commands = { execute } as unknown as ICommandBus;
    expect(await restoreFlowLibrary(commands, [template])).toBe(1);
    expect(execute.mock.calls[0][0]).toBe(FlowLibraryCommand.Restore);
    expect(template.name).toBe('Host template');
});

it('skips an empty catalog and returns the application recovery count', async () => {
    const execute = vi.fn().mockResolvedValue(1);
    const commands = { execute } as unknown as ICommandBus;
    expect(await restoreFlowLibrary(commands, [])).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(await restoreFlowLibrary(commands, [template, { ...template, id: 'second' as FlowId }])).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
});
