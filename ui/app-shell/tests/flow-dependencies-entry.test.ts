// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {FlowCommand, type FlowDraft} from '@itookit/llm-flow/contracts';
import {FlowsEditor} from '../../llm-ui-adapter/src/components/FlowsEditor';

const editors: FlowsEditor[] = [];
afterEach(async () => {for (const editor of editors.splice(0)) await editor.destroy(); document.body.replaceChildren(); vi.restoreAllMocks();});
it.each([undefined, 'global', 'local'] as const)('offers dependency inspection only for root-callable workflow details (exposure=%s)', async exposure => {
    const draft = {id: 'selected', name: 'Selected', exposure, draftVersion: 1, updatedAt: 0, nodes: [], edges: [], layout: {}} as FlowDraft;
    const execute = vi.fn(async (command: string) => {
        if (command === FlowCommand.Presentations) return [];
        if (command === FlowCommand.DraftLoad) return draft;
        if (command === FlowCommand.SourceCheck) return {valid: true, diagnostics: []};
        return [];
    });
    const inspectDependencies = vi.fn(() => new Promise<void>(() => {}));
    const root = document.createElement('div'); document.body.append(root);
    const editor = new FlowsEditor({commands: {execute} as never, inspectDependencies}, '/selected.flow'); editors.push(editor); await editor.init(root);
    const button = root.querySelector<HTMLButtonElement>('[data-action=dependencies]');
    if (exposure === 'local') {expect(button).toBeNull(); expect(inspectDependencies).not.toHaveBeenCalled(); return;}
    expect(button).not.toBeNull(); button!.click(); button!.click();
    expect(inspectDependencies).toHaveBeenCalledOnce(); expect(inspectDependencies).toHaveBeenCalledWith('selected', expect.any(AbortSignal));
    await editor.destroy(); expect(inspectDependencies.mock.calls[0][1].aborted).toBe(true);
});
