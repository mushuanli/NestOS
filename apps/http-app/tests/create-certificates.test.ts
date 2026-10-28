import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCertificates, createUserCertificate } from '@itookit/node-host/http';

let directory: string | undefined;
afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
});

it('explains how to reuse certificates and preserves an existing directory', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'nestos-existing-certs-'));
    await writeFile(path.join(directory, 'ca.key'), 'existing private key');
    await expect(createCertificates(directory, ['192.168.31.10'])).rejects.toThrow('Reuse this directory');
    expect(await readFile(path.join(directory, 'ca.key'), 'utf8')).toBe('existing private key');
    expect(await readdir(directory)).toEqual(['ca.key']);
});

it('issues separate li and sxw identities using the existing CA without replacing admin', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'nestos-user-certificates-'));
    const ca = path.join(directory, 'ca'); await createCertificates(ca, ['127.0.0.1']);
    const admin = await readFile(path.join(ca, 'client.crt')), authority = await readFile(path.join(ca, 'ca.crt'));
    const li = await createUserCertificate(ca, 'li'), sxw = await createUserCertificate(ca, 'sxw');
    expect(li.fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(sxw.fingerprint).not.toBe(li.fingerprint);
    expect(await readFile(path.join(ca, 'client.crt'))).toEqual(admin);
    expect(await readFile(path.join(ca, 'ca.crt'))).toEqual(authority);
    expect((await readFile(li.bundleFile)).length).toBeGreaterThan(0);
    await expect(createUserCertificate(ca, 'li')).rejects.toThrow();
    expect((await readFile(li.bundleFile)).length).toBeGreaterThan(0);
});
