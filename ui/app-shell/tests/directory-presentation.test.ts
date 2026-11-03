import {afterEach, expect, it} from 'vitest';
import {getLogger, LogLevel} from '@itookit/common';
import {directoryPresentation} from '../src/workbench/directory-presentation';

afterEach(() => {getLogger().clear(); getLogger().setLevel('directory-view', LogLevel.INFO);});
it('correlates successful and failed directory operations without logging private error messages', async () => {
    getLogger().setLevel('directory-view', LogLevel.DEBUG);
    const trace = directoryPresentation().trace!;
    expect(await trace('directory.refresh', async () => ['resource'])).toEqual(['resource']);
    const cause = Object.assign(new Error('private file body and token'), {code: 'EACCES'});
    const wrapped = Object.assign(new Error('private search query', {cause}), {code: 'EIO'});
    await expect(trace('directory.refresh', async () => {throw wrapped;})).rejects.toBe(wrapped);
    const logs = getLogger().query({modules: ['directory-view']});
    expect(logs).toHaveLength(4);
    const metadata = logs.map(entry => entry.data as Record<string, unknown>);
    expect(metadata[0]!.operationId).toBe(metadata[1]!.operationId);
    expect(metadata[2]!.operationId).toBe(metadata[3]!.operationId);
    expect(metadata[0]!.operationId).not.toBe(metadata[2]!.operationId);
    expect(metadata[1]).toMatchObject({stage: 'complete', result: 'success', durationMs: expect.any(Number)});
    expect(metadata[3]).toMatchObject({stage: 'complete', result: 'failure', code: 'EACCES', durationMs: expect.any(Number)});
    expect(JSON.stringify(logs)).not.toContain('private');
});
