// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { FlowCommand, type FlowDraft, type FlowRevision } from '@itookit/llm-flow/contracts';
import { t } from '@itookit/common';
import { createApplicationRuntime } from '../../../backend/app-core/src/runtime/create-application-runtime';
import { bindLocalApplicationServices } from '../../../backend/app-core/src/host/application-services';
import { createApplicationClient } from '../../../backend/app-core/src/host/application-client';
import { RecoverySettingsEditor } from '../../app-settings/src/editors/RecoverySettingsEditor';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.restoreAllMocks(); });

async function restore(container: HTMLElement) {
    const selected = container.querySelector<HTMLInputElement>('[data-initial-id="flow:anki-generate"]')!;
    if (!selected.checked) selected.click();
    container.querySelector<HTMLButtonElement>('#btn-batch-restore')!.click();
    document.querySelector<HTMLButtonElement>('.settings-modal-confirm')!.click();
    await vi.waitFor(() => expect(document.querySelector('.settings-modal')).toBeNull());
}

it('restores the single self-contained Anki Flow from System Recovery and preserves later edits', async () => {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web', digitalTwinAutoStart: false });
    cleanup.push(() => runtime.dispose());
    const client = createApplicationClient(bindLocalApplicationServices(runtime)); cleanup.push(() => client.close());
    await runtime.flowEngine.deleteFile((await runtime.flowEngine.findFile('anki-generate.flow'))!.nodeId);
    const files = await client.backend.initialFiles(), selectedRestore = vi.spyOn(files, 'restore');
    const container = document.createElement('div'); document.body.append(container);
    const editor = new RecoverySettingsEditor(container, runtime.agentService, {} as never, undefined, files);
    cleanup.push(() => editor.destroy()); await editor.render();
    expect([...container.querySelectorAll<HTMLElement>('[data-initial-id]')].map(input => input.dataset.initialId)).toEqual([
        'note:demo', 'flow:essay-review', 'flow:anki-generate',
    ]);
    expect(container.textContent).toContain('/home/admin/flows/anki-generate.flow');
    expect(container.querySelector<HTMLElement>('[data-initial-id="flow:anki-generate"]')!.parentElement!.textContent).toContain(t('initialFiles.missing'));
    await restore(container);
    expect(selectedRestore).toHaveBeenLastCalledWith(['flow:anki-generate']);
    expect(container.querySelector('[role=status]')!.textContent).toContain(t('initialFiles.restored'));
    const draft = await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, { id: 'anki-generate' });
    const published = await runtime.commandBus.execute<FlowRevision>(FlowCommand.RevisionGet, { id: draft.id });
    expect(draft.functions?.map(fn => fn.id)).toEqual(['anki-build', 'anki-recognize-group', 'anki-complete-batch']);
    expect(published.functions?.map(fn => fn.id)).toEqual(draft.functions!.map(fn => fn.id));
    expect((await runtime.commandBus.execute<FlowDraft[]>(FlowCommand.DraftList, {})).map(flow => flow.id).sort()).toEqual(['anki-generate', 'essay-review']);
    for (const fn of draft.functions!) expect(await runtime.commandBus.execute(FlowCommand.RevisionGet, { id: fn.id })).toBeNull();
    for (const id of ['anki-build', 'anki-from-image', 'anki-recognize-group', 'anki-complete-batch'])
        expect(await runtime.commandBus.execute(FlowCommand.DraftLoad, { id })).toBeNull();
    expect(await (await runtime.vfs.openFileSystem('/home/admin/minds')).driver.exists('/demo.md')).toBe(false);
    draft.name = 'My Anki workflow'; draft.functions![0].name = 'My inline function';
    await runtime.commandBus.execute(FlowCommand.DraftSave, { draft, expectedDraftVersion: draft.draftVersion });
    const saved = await runtime.commandBus.execute<FlowDraft>(FlowCommand.DraftLoad, { id: draft.id });
    await restore(container);
    expect(container.querySelector('[role=status]')!.textContent).toContain(t('initialFiles.preserved'));
    expect(await runtime.commandBus.execute(FlowCommand.DraftLoad, { id: draft.id })).toEqual(saved);
    expect(await runtime.commandBus.execute(FlowCommand.RevisionGet, { id: draft.id })).toEqual(published);
}, 15_000);
