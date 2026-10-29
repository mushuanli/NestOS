import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {captureSourceGuard} from '../httpd-build.mjs';
import {sourceHash} from '../local-library-plan.mjs';
import {isHttpBuildSource} from '../build-source-policy.mjs';

test('HTTP fences ignore tests, documentation and other app implementations but retain real inputs', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'http-input-policy-'));
    const write = (file, value) => {mkdirSync(path.dirname(path.join(root, file)), {recursive: true}); writeFileSync(path.join(root, file), value);};
    try {
        execFileSync('git', ['init', '--quiet'], {cwd: root});
        for (const file of ['ui/chat/src/view.ts', 'apps/web-app/src/main.ts', 'apps/http-app/src/server/main.ts', 'apps/node-host/src/host.ts', 'pnpm-lock.yaml']) write(file, 'initial');
        write('tools/image-tools/package.json', '{}'); write('tools/image-tools/src/index.ts', 'initial');
        const guard = captureSourceGuard(root);
        for (const file of ['ui/chat/src/view.test.ts', 'backend/p/tests/run.ts', 'shared/p/__tests__/run.ts', 'scripts/tests/build.test.mjs',
            'doc/design/ui.md', 'AGENTS.md', 'apps/tauri-app/src/config/modules.ts', 'apps/cli/src/cli.ts', 'tools/nestos-node/src/main.rs']) write(file, 'irrelevant');
        guard.check();
        write('apps/web-app/src/main.ts', 'changed');
        assert.throws(() => guard.check(), error => error.code === 'HTTP_BUILD_SOURCE_CHANGED' && error.changedFiles.join() === 'apps/web-app/src/main.ts');
        write('apps/web-app/src/main.ts', 'initial'); guard.check();
        write('tools/image-tools/src/index.ts', 'changed');
        assert.throws(() => guard.check(), error => error.changedFiles.join() === 'tools/image-tools/src/index.ts');
        write('tools/image-tools/src/index.ts', 'initial'); guard.check();
        write('shared/p/src/added.ts', 'new production module');
        assert.throws(() => guard.check(), error => error.changedFiles.includes('shared/p/src/added.ts'));
        assert.equal(isHttpBuildSource('apps/tauri-app/package.json'), true);
        assert.equal(isHttpBuildSource('scripts/httpd-build.mjs'), true);
        assert.equal(isHttpBuildSource('libraries/llm-ui/src/composer.ts'), false);
    } finally {rmSync(root, {recursive: true, force: true});}
});
test('library artifacts ignore test-only edits but still detect production and packaging changes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lib-input-policy-'));
    const write = (file, value) => {mkdirSync(path.dirname(path.join(root, file)), {recursive: true}); writeFileSync(path.join(root, file), value);};
    try {
        write('src/index.ts', 'export const value = 1'); write('package.json', '{"version":"1.0.0"}');
        const before = sourceHash(root);
        write('tests/index.test.ts', 'test'); write('src/__tests__/helper.ts', 'helper'); write('src/value.spec.ts', 'spec');
        assert.equal(sourceHash(root), before);
        write('src/index.ts', 'export const value = 2'); assert.notEqual(sourceHash(root), before);
    } finally {rmSync(root, {recursive: true, force: true});}
});
