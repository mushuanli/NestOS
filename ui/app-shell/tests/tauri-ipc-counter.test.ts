import { expect, it, vi } from 'vitest';
import { countIpc } from '../../../apps/tauri-app/src/log/ipc-counter';
it('counts real command submissions including failures, excludes trace writes without modifying the immutable host invoke', async () => {
    const original = vi.fn(async (command: string) => { if (command === 'fail') throw new Error('offline'); return 'ok'; });
    const port = Object.freeze({ invoke: original }), counter = countIpc(port);
    await counter.invoke('fs_stat_prefixes');
    await counter.invoke('plugin:sql|select');
    await expect(counter.invoke('fail')).rejects.toThrow('offline');
    await counter.uncounted('fs_append_file', { data: 'trace' });
    expect(counter.snapshot()).toEqual({ fs_stat_prefixes: 1, 'plugin:sql|select': 1, fail: 1 });
    const snapshot = counter.snapshot(); snapshot.fail = 100;
    expect(counter.snapshot().fail).toBe(1);
    expect(port.invoke).toBe(original);
    await port.invoke('fs_stat_prefixes');
    expect(counter.snapshot().fs_stat_prefixes).toBe(1);
});
