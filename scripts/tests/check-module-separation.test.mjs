import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeSpecifiers, separationErrors, moduleRole, directoryErrors } from '../check-module-separation.mjs';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'x1-module-boundary-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const add = (name, source) => {
        const group = name === 'app-core' ? 'backend' : ['app-contracts', 'app-transport'].includes(name) ? 'shared' : name === 'node-host' ? 'apps' : 'ui';
        const directory = join(root, group, name);
        mkdirSync(join(directory, 'src'), { recursive: true });
        writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@itookit/' + name, exports: { '.': './src/index.ts' } }));
        writeFileSync(join(directory, 'src/index.ts'), source);
    };
    return { root, add };
}

test('type-only dependencies are erased while re-exports, lazy and CommonJS loads are checked', () => {
    assert.deepEqual(runtimeSpecifiers("import type { Backend } from 'backend'; export type { X } from 'other'; type T = import('types').T;"), []);
    assert.deepEqual(runtimeSpecifiers("export { factory } from 'backend'; import('lazy'); require('node:fs');"), ['backend', 'lazy', 'node:fs']);
});

test('a frontend barrel cannot hide a backend dependency through shared contracts', t => {
    const { root, add } = fixture(t);
    add('app-shell', "export { run } from '@itookit/app-contracts';");
    add('app-contracts', "export { run } from '@itookit/app-core';");
    add('app-core', 'export function run() {}');
    const errors = separationErrors(root);
    assert.ok(errors.some(error => /frontend loads backend.*app-contracts.*app-core/.test(error)));
    assert.ok(errors.some(error => /shared loads backend/.test(error)));
});

test('backend cannot load UI and frontend cannot derive contracts from backend classes', t => {
    const { root, add } = fixture(t);
    add('app-shell', "import type { Runtime } from '@itookit/app-core'; export const ui = 1;");
    add('app-core', "export interface Runtime {} export const load = () => import('@itookit/app-shell');");
    const errors = separationErrors(root);
    assert.ok(errors.some(error => error.startsWith('frontend references implementation contract')));
    assert.ok(errors.some(error => error.startsWith('backend loads frontend')));
});

test('domain contracts and codecs are shared while host factories and independent storage drivers are backend', () => {
    assert.equal(moduleRole('/repo/backend/app-core/src/contracts/backend.ts', '/repo'), 'shared');
    assert.equal(moduleRole('/repo/backend/app-core/src/host/application-client.ts', '/repo'), 'backend');
    assert.equal(moduleRole('/repo/backend/kernel-adapters/src/llm-management/config.ts', '/repo'), 'shared');
    assert.equal(moduleRole('/repo/libraries/vfsdriver-local/src/index.ts', '/repo'), 'backend');
    assert.equal(moduleRole('/repo/libraries/durable-kernel/src/application/kernel.ts', '/repo'), 'backend');
    assert.equal(moduleRole('/repo/libraries/durable-kernel/src/contracts.ts', '/repo'), 'shared');
    assert.equal(moduleRole('/repo/libraries/device-tty/src/contracts.ts', '/repo'), 'shared');
    assert.equal(moduleRole('/repo/libraries/device-tty/src/index.ts', '/repo'), 'backend');
    assert.equal(moduleRole('/repo/libraries/driver-llm/src/types/provider.ts', '/repo'), 'shared');
    assert.equal(moduleRole('/repo/libraries/image-parser/src/processing.ts', '/repo'), 'shared');
    assert.equal(moduleRole('/repo/libraries/image-parser/src/processor.ts', '/repo'), 'frontend');
    assert.equal(moduleRole('/repo/tools/image-tools/src/node.ts', '/repo'), 'backend');
    assert.equal(moduleRole('/repo/tools/image-tools/src/browser.ts', '/repo'), 'host');
});

test('installed library artifacts retain frontend, backend and shared boundaries', () => {
    const base = '/repo/release/local-libraries/locks/id/node_modules/.pnpm/artifact/node_modules/@itookit';
    assert.equal(moduleRole(base + '/llm-ui/dist/llm-ui.js', '/repo'), 'frontend');
    assert.equal(moduleRole(base + '/vfs-core/dist/index.cjs', '/repo'), 'shared');
    assert.equal(moduleRole(base + '/durable-kernel/dist/index.js', '/repo'), 'backend');
    assert.equal(moduleRole(base + '/device-tty/dist/contracts.js', '/repo'), 'shared');
    assert.equal(moduleRole(base + '/image-parser/dist/validation-C_H52RVd.cjs', '/repo'), 'shared');
    assert.equal(moduleRole(base + '/image-parser/dist/ui.js', '/repo'), 'frontend');
});

test('browser tool assembly is host-owned and stays unreachable from Node entrypoints', t => {
    const {root, add} = fixture(t); add('app-shell', 'export const ui = 1;');
    const directory = join(root, 'tools/image-tools'); mkdirSync(join(directory, 'src'), {recursive: true});
    writeFileSync(join(directory, 'package.json'), JSON.stringify({name: '@itookit/image-tools', exports: {'.': './src/node.ts'}}));
    writeFileSync(join(directory, 'src/node.ts'), 'export const node = 1;');
    writeFileSync(join(directory, 'src/browser.ts'), "import '@itookit/app-shell';");
    assert.deepEqual(separationErrors(root), []);
    writeFileSync(join(directory, 'src/node.ts'), "import './browser';");
    assert.ok(separationErrors(root).some(error => /backend loads frontend.*browser.*app-shell/.test(error)));
});


test('a business UI package kept outside ui is rejected even if its imports are otherwise empty', t => {
    const { root } = fixture(t), directory = join(root, 'libraries/app-shell');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@itookit/app-shell' }));
    assert.deepEqual(directoryErrors(root), ['@itookit/app-shell belongs in ui/, found in libraries/']);
});

test('neutral application interfaces are permitted and backend type-only UI references are rejected', t => {
    const { root, add } = fixture(t);
    add('app-contracts', 'export interface ProjectPort { list(): Promise<string[]> }');
    add('app-shell', "import type { ProjectPort } from '@itookit/app-contracts'; export interface View { projects: ProjectPort }");
    add('app-core', "import type { View } from '@itookit/app-shell'; export type Service = View;");
    const errors = separationErrors(root);
    assert.equal(errors.filter(error => error.startsWith('frontend')).length, 0);
    assert.ok(errors.some(error => /backend references implementation contract/.test(error)));
});


test('legacy packages cannot silently fall outside workspace directory checks', t => {
    const { root } = fixture(t), directory = join(root, 'packages/app-shell');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@itookit/app-shell' }));
    assert.deepEqual(directoryErrors(root), ['packages/app-shell must move to ui/, backend/, shared/ or apps/']);
});

test('type-only relative imports cannot bypass application implementation isolation', t => {
    const { root, add } = fixture(t);
    add('app-core', 'export interface Runtime {}');
    add('app-shell', "type Runtime = import('../../../backend/app-core/src/index').Runtime;");
    assert.ok(separationErrors(root).some(error => /frontend references implementation contract/.test(error)));
});


test('portable transport cannot load the Node host, and Node host cannot load UI', t => {
    const {root, add} = fixture(t);
    add('app-transport', "export {host} from '@itookit/node-host';");
    add('node-host', "export {ui as host} from '@itookit/app-shell';");
    add('app-shell', 'export const ui = 1;');
    const errors = separationErrors(root);
    assert.ok(errors.some(error => /shared loads backend/.test(error)));
    assert.ok(errors.some(error => /backend loads frontend/.test(error)));
});
