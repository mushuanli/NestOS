import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzip, gunzipSync } from 'node:zlib';
import type { ServerResponse } from 'node:http';
import { serveStatic } from '../src/server/static-files';

vi.mock('node:zlib', async original => { const actual = await original<typeof import('node:zlib')>(); return { ...actual, gzip: vi.fn(actual.gzip) }; });
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'mindos-assets-')); await mkdir(path.join(directory, 'assets')); vi.mocked(gzip).mockClear(); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function response() { return { writeHead: vi.fn(), end: vi.fn() }; }
it('reuses compressed hashed assets and honors conditional requests', async () => {
    await writeFile(path.join(directory, 'assets/app-abcdefgh.js'), 'const text = "cached";');
    const first = response(); await serveStatic(first as unknown as ServerResponse, 'GET', directory, '/assets/app-abcdefgh.js', true);
    const headers = first.writeHead.mock.calls[0][1]; expect(headers['Cache-Control']).toContain('immutable');
    expect(gunzipSync(first.end.mock.calls[0][0]).toString()).toContain('cached');
    const second = response(); await serveStatic(second as unknown as ServerResponse, 'GET', directory, '/assets/app-abcdefgh.js', true, headers.ETag);
    expect(second.writeHead.mock.calls[0][0]).toBe(304); expect(second.end).toHaveBeenCalledWith(undefined);
    expect(gzip).toHaveBeenCalledOnce();
    const plain = response(); await serveStatic(plain as unknown as ServerResponse, 'HEAD', directory, '/assets/app-abcdefgh.js', false);
    expect(plain.writeHead.mock.calls[0][1].ETag).not.toBe(headers.ETag); expect(plain.end).toHaveBeenCalledWith(undefined);
});
it('revalidates HTML and refreshes cached bytes after a deployment', async () => {
    await writeFile(path.join(directory, 'index.html'), '<title>before</title>');
    const first = response(); await serveStatic(first as unknown as ServerResponse, 'GET', directory, '/', false);
    const headers = first.writeHead.mock.calls[0][1]; expect(headers['Cache-Control']).toBe('private, no-cache');
    await writeFile(path.join(directory, 'index.html'), '<title>after deployment</title>');
    const second = response(); await serveStatic(second as unknown as ServerResponse, 'GET', directory, '/', false, headers.ETag);
    expect(second.writeHead.mock.calls[0][0]).toBe(200); expect(second.end.mock.calls[0][0].toString()).toContain('after deployment');
    expect(second.writeHead.mock.calls[0][1].ETag).not.toBe(headers.ETag);
});
