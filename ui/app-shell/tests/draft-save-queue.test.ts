import { it, expect, vi } from 'vitest';
import { DraftSaveQueue } from '../../llm-ui/src/shell/drafts/draft-save-queue';

it('retains unsaved state on error, retries later edits, and preserves write order', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const state = vi.fn(), queue = new DraftSaveQueue(write, state);
    queue.save(Promise.resolve('first'));
    await expect(queue.flush()).rejects.toThrow('offline'); expect(queue.dirty).toBe(true);
    queue.save(Promise.resolve('second')); queue.save(Promise.resolve('third'));
    await queue.flush(); expect(queue.dirty).toBe(false);
    expect(write.mock.calls.map(call => call[0])).toEqual(['first', 'second', 'third']);
    expect(state).toHaveBeenLastCalledWith();
});
