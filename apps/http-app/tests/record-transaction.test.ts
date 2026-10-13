import { expect, it, vi } from 'vitest';
import { HttpRecordTransaction } from '../src/client/record-transaction';
import type { HttpTransport } from '../src/client/transport';

it('skips a transaction without reads or writes but still validates read-only observations', async () => {
    const call = vi.fn().mockResolvedValueOnce([['value']]).mockResolvedValueOnce(undefined);
    const transport = { call } as unknown as HttpTransport;
    const empty = new HttpRecordTransaction(transport);
    await empty.commit();
    expect(call).not.toHaveBeenCalled();
    const reader = new HttpRecordTransaction(transport);
    expect(await reader.getRecordField('/one.seq', 'title')).toBe('value');
    expect(await reader.getRecordField('/one.seq', 'title')).toBe('value');
    expect(call).toHaveBeenCalledOnce();
    await reader.commit();
    expect(call).toHaveBeenLastCalledWith('records.commit', [expect.objectContaining({
        observations: [expect.objectContaining({ kind: 'get' })], mutations: [],
    })]);
});
