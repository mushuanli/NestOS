import { expect, it, vi } from 'vitest';
import { VFSHelpers } from '../../src/llm-management/device/vfs-helpers';

it('bounds concurrent configuration reads and preserves directory order', async () => {
    const releases: Array<() => void> = [];
    const readContent = vi.fn((path: string) => new Promise<string>(resolve => {
        releases.push(() => resolve(JSON.stringify({ path })));
    }));
    const paths = Array.from({ length: 13 }, (_, i) => `/configs/${i}.json`);
    const driver = {
        resolvePath: vi.fn(async () => '/configs'),
        getChildren: vi.fn(async () => paths.map(path => ({ path, name: path, type: 'file' }))),
        readContent,
    };
    const loading = new VFSHelpers({ driver } as never).loadJsonFilesFromDir('/configs');
    await vi.waitFor(() => expect(readContent).toHaveBeenCalledTimes(8));
    releases.slice().reverse().forEach(release => release());
    await vi.waitFor(() => expect(readContent).toHaveBeenCalledTimes(13));
    releases.slice(8).reverse().forEach(release => release());
    expect(await loading).toEqual(paths.map(path => ({ path })));
});

it('skips unreadable, empty and invalid files while loading valid YAML and JSON', async () => {
    const files = ['good.yaml', 'broken.json', 'empty.yml', 'invalid.json', 'missing.json', 'good.json', 'ignored.txt'];
    const contents: Record<string, string> = {
        'good.yaml': 'id: yaml', 'broken.json': '{', 'empty.yml': '',
        'invalid.json': '{"other":true}', 'good.json': '{"id":"json"}',
    };
    const readContent = vi.fn(async (path: string) => {
        if (!(path in contents)) throw new Error('Read failed');
        return new TextEncoder().encode(contents[path]);
    });
    const driver = {
        resolvePath: vi.fn(async () => '/configs'),
        getChildren: vi.fn(async () => files.map(name => ({ path: name, name, type: 'file' }))),
        readContent,
    };
    const validate = (value: unknown): value is { id: string } =>
        typeof value === 'object' && value !== null && 'id' in value;
    expect(await new VFSHelpers({ driver } as never).loadJsonFilesFromDir('/configs', undefined, validate))
        .toEqual([{ id: 'yaml' }, { id: 'json' }]);
    expect(readContent).toHaveBeenCalledTimes(6);
});
