import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCertificates } from '../src/server/create-certificates';

let directory: string | undefined;
afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
});

it('explains how to reuse certificates and preserves an existing directory', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'mindos-existing-certs-'));
    await writeFile(path.join(directory, 'ca.key'), 'existing private key');
    await expect(createCertificates(directory, ['192.168.31.10'])).rejects.toThrow('Reuse this directory');
    expect(await readFile(path.join(directory, 'ca.key'), 'utf8')).toBe('existing private key');
    expect(await readdir(directory)).toEqual(['ca.key']);
});
