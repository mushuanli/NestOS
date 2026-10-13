import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localLibraryOverrides } from '../local-libraries.cjs';
import { libraries } from '../npm-libraries.mjs';

test('prefers a matching local library and restores registry resolution when its checkout is removed', () => {
    const root = mkdtempSync(join(tmpdir(), 'x1-local-libraries-'));
    const libraries = [{ directory: 'mdxeditor', name: '@itookit/mdxeditor' },
        { directory: 'vfs-ui', name: '@itookit/vfs-ui' }, { directory: 'app-core', name: '@itookit/app-core', workspace: true }];
    try {
        assert.deepEqual(localLibraryOverrides(root, libraries), {});
        const editor = join(root, 'packages/mdxeditor'); mkdirSync(editor, { recursive: true });
        writeFileSync(join(editor, 'package.json'), JSON.stringify({ name: '@itookit/mdxeditor' }));
        assert.deepEqual(localLibraryOverrides(root, libraries), { '@itookit/mdxeditor': 'file:./packages/mdxeditor' });
        const source = join(root, 'packages/vfs-ui'); mkdirSync(source, { recursive: true });
        writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@itookit/vfs-ui', exports: { '.': './src/index.ts' }, files: ['dist'] }));
        assert.equal(localLibraryOverrides(root, libraries)['@itookit/vfs-ui'], 'link:./packages/vfs-ui');
        rmSync(source, { recursive: true });
        const workspace = join(root, 'packages/app-core'); mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: '@itookit/app-core' }));
        assert.equal(localLibraryOverrides(root, libraries)['@itookit/app-core'], undefined);
        writeFileSync(join(editor, 'package.json'), JSON.stringify({ name: 'unexpected' }));
        assert.throws(() => localLibraryOverrides(root, libraries), /name mismatch/);
        rmSync(editor, { recursive: true });
        assert.deepEqual(localLibraryOverrides(root, libraries), {});
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applies the same local-first rule to every standalone library in the release catalog', () => {
    const root = mkdtempSync(join(tmpdir(), 'x1-local-catalog-'));
    try {
        const standalone = libraries.filter(library => !library.workspace);
        for (const library of standalone) {
            const directory = join(root, 'packages', library.directory); mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: library.name }));
        }
        const overrides = localLibraryOverrides(root, libraries);
        assert.equal(Object.keys(overrides).length, standalone.length);
        for (const library of standalone) assert.equal(overrides[library.name], `file:./packages/${library.directory}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
