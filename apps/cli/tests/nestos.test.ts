import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveNestosProfile, resolveNestosRoot } from '../src/nestos';

const originalXdg = process.env.XDG_CONFIG_HOME;
const originalRoot = process.env.NESTOS_ROOT;
const cleanup: string[] = [];

afterEach(async () => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalRoot === undefined) delete process.env.NESTOS_ROOT;
    else process.env.NESTOS_ROOT = originalRoot;
    await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function configDir(settings: Record<string, unknown>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'nestos-profile-'));
    cleanup.push(root);
    const dir = path.join(root, 'nestos');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'nestos.json'), JSON.stringify(settings), 'utf8');
    process.env.XDG_CONFIG_HOME = root;
    return dir;
}

describe('NestOS profile resolution', () => {
    it('creates shared defaults beside existing data and preserves later edits', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'nestos-default-'));
        cleanup.push(root); process.env.XDG_CONFIG_HOME = root; delete process.env.NESTOS_ROOT;
        const dir = path.join(root, 'nestos');
        await mkdir(path.join(dir, 'data'), { recursive: true });
        await writeFile(path.join(dir, 'data', 'keep'), 'existing data');
        expect(resolveNestosRoot()).toBe(path.join(dir, 'data'));
        expect(JSON.parse(await readFile(path.join(dir, 'nestos.json'), 'utf8')))
            .toEqual({ rootDir: 'data', storageVersion: 1, layoutVersion: 1 });
        const custom = '{"rootDir":"elsewhere","custom":true}';
        await writeFile(path.join(dir, 'nestos.json'), custom);
        expect(resolveNestosRoot()).toBe(path.join(dir, 'elsewhere'));
        expect(await readFile(path.join(dir, 'nestos.json'), 'utf8')).toBe(custom);
        expect(await readFile(path.join(dir, 'data', 'keep'), 'utf8')).toBe('existing data');
    });
    it('does not persist a temporary environment override', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'nestos-env-'));
        cleanup.push(root); process.env.XDG_CONFIG_HOME = root; process.env.NESTOS_ROOT = '/temporary';
        expect(resolveNestosRoot()).toBe('/temporary');
        delete process.env.NESTOS_ROOT;
        expect(resolveNestosRoot()).toBe(path.join(root, 'nestos', 'data'));
    });
    it('reads nestos.json rootDir relative to the config dir', async () => {
        const dir = await configDir({ rootDir: 'data' });
        expect(resolveNestosRoot()).toBe(path.join(dir, 'data'));
        expect(resolveNestosProfile().storageVersion).toBe(1);
    });

    it('lets NESTOS_ROOT override nestos.json', async () => {
        await configDir({ rootDir: '/from-config' });
        process.env.NESTOS_ROOT = '/from-env';
        expect(resolveNestosRoot()).toBe('/from-env');
    });

    it('falls back to <config-dir>/data', async () => {
        const dir = await configDir({});
        expect(resolveNestosRoot()).toBe(path.join(dir, 'data'));
    });
});
