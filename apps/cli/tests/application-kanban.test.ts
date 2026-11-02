import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ApplicationClient} from '@itookit/app-contracts/services';
import {kanbanCommand} from '../src/application-kanban';
const paths: string[] = [];
afterEach(async () => {for (const path of paths.splice(0)) await rm(path, {recursive: true, force: true});});
it('passes frozen mutations unchanged and never retries an unknown outcome', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kanban-cli-')); paths.push(directory);
    const file = join(directory, 'request.json'), request = {operationId: 'original', expectedRevision: 4,
        command: {type: 'append-record', record: {id: 'decision'}}};
    await writeFile(file, JSON.stringify(request));
    const execute = vi.fn(async () => {throw Object.assign(new Error('Unknown'), {outcome: 'unknown'});});
    const client = {services: {kanban: {execute}}} as unknown as ApplicationClient;
    await expect(kanbanCommand(client, ['execute', 'board'], {file})).rejects.toMatchObject({outcome: 'unknown'});
    expect(execute).toHaveBeenCalledExactlyOnceWith('board', request);
});
it('fails explicitly when the host has no Kanban service', async () => {
    await expect(kanbanCommand({services: {}} as ApplicationClient, ['list'], {})).rejects.toMatchObject({code: 'ECAPABILITY'});
});
