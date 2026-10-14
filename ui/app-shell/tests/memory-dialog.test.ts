// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import type { SessionMemoryControls } from '@itookit/llm-session';
import { showMemoryDialog } from '../src/files/memory-dialog';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('edits with the selected hash, preserves conflicting input, and creates with an absence condition', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: () => {} });
    const entry = { scope: 'project', entryId: 'note', content: 'original', contentHash: 'a'.repeat(64), revision: 'first' };
    const memory = { list: vi.fn().mockResolvedValue([entry]), upsert: vi.fn().mockRejectedValueOnce(new Error('conflict')).mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) };
    const closed = showMemoryDialog(memory as unknown as SessionMemoryControls, [{ id: 'agent', name: 'Agent' }]);
    const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent === text)!;
    const idle = () => vi.waitFor(() => expect(button(t('memory.manage.save')).disabled).toBe(false));
    await idle(); button('project / note').click();
    const content = document.querySelector('textarea')!; content.value = 'edited';
    button(t('memory.manage.save')).click(); await idle();
    expect(memory.upsert).toHaveBeenLastCalledWith('agent', { scope: 'project', entryId: 'note', content: 'edited' }, { expectedContentHash: entry.contentHash, expectedRevision: entry.revision });
    expect(content.value).toBe('edited'); expect(document.querySelector('[role=status]')?.textContent).toBe('conflict');
    button(t('memory.manage.delete')).click(); await idle();
    expect(memory.remove).toHaveBeenCalledWith('agent', 'project', 'note', { expectedContentHash: entry.contentHash, expectedRevision: entry.revision });
    button(t('memory.manage.new')).click();
    const inputs = document.querySelectorAll('input'); inputs[0].value = 'project'; inputs[1].value = 'new'; content.value = '<script>plain text</script>';
    button(t('memory.manage.save')).click(); await idle();
    expect(memory.upsert).toHaveBeenLastCalledWith('agent', { scope: 'project', entryId: 'new', content: '<script>plain text</script>' }, { expectedContentHash: null, expectedRevision: null });
    expect(document.querySelector('script')).toBeNull();
    button(t('memory.manage.close')).click(); await closed; expect(document.querySelector('dialog')).toBeNull();
});

it('keeps the draft while comparing and explicitly adopting a concurrent version', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: () => {} });
    const entry = { scope: 'project', entryId: 'note', content: 'original', contentHash: 'a'.repeat(64), revision: 'first' };
    const memory = { list: vi.fn().mockResolvedValue([entry]), upsert: vi.fn().mockResolvedValue(undefined) };
    const closed = showMemoryDialog(memory as unknown as SessionMemoryControls, [{ id: 'agent', name: 'Agent' }]);
    const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
    const idle = () => vi.waitFor(() => expect(button(t('memory.manage.save')).disabled).toBe(false));
    await idle(); button('project / note').click();
    const content = document.querySelector('textarea')!; content.value = 'my draft';
    const latest = { ...entry, revision: 'second', contentHash: 'b'.repeat(64), content: '<script>concurrent edit</script>' };
    memory.list.mockResolvedValue([latest]);
    button(t('memory.manage.compare')).click(); await idle();
    expect(content.value).toBe('my draft');
    expect(document.querySelector('pre')?.textContent).toBe(latest.content);
    expect(document.querySelector('script')).toBeNull();
    expect(memory.upsert).not.toHaveBeenCalled();
    button(t('memory.manage.useCompared')).click();
    button(t('memory.manage.save')).click(); await idle();
    expect(memory.upsert).toHaveBeenCalledWith('agent', { scope: 'project', entryId: 'note', content: 'my draft' },
        { expectedContentHash: latest.contentHash, expectedRevision: latest.revision });
    button(t('memory.manage.close')).click(); await closed;
});
