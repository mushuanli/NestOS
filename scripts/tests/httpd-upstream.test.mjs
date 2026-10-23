import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

function fixture(libraryExitCode) {
    const root = mkdtempSync(path.join(tmpdir(), 'httpd-upstream-'));
    mkdirSync(path.join(root, 'scripts')); mkdirSync(path.join(root, 'release/httpd'), {recursive: true});
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(path.join(root, 'release/httpd/current.json'), '{"id":"previous"}\n');
    writeFileSync(path.join(root, 'scripts/httpd.mjs'), readFileSync(new URL('../httpd.mjs', import.meta.url)));
    writeFileSync(path.join(root, 'scripts/httpd-runtime.mjs'), `
        export const hostArguments = () => [], hostEnvironment = () => ({}), runtimePaths = () => ({}), runtimeLog = () => ({});
        export const releaseDirectory = (root, id) => root + '/' + id, verifyRelease = () => {};
    `);
    writeFileSync(path.join(root, 'scripts/local-libraries.mjs'), `
        import {appendFileSync} from 'node:fs';
        if (process.argv[2] !== 'build') process.exit(9);
        appendFileSync('order.txt', 'libraries\\n'); process.exit(${libraryExitCode});
    `);
    writeFileSync(path.join(root, 'scripts/httpd-build.mjs'), `
        import assert from 'node:assert/strict'; import {appendFileSync, readFileSync} from 'node:fs';
        export function buildHttpRelease(root, options) {
            assert.equal(readFileSync(root + '/order.txt', 'utf8'), 'libraries\\n');
            appendFileSync(root + '/order.txt', 'http\\n'); options.activate?.('next'); return 'next';
        }
    `);
    return {root, run: () => spawnSync(process.execPath, ['scripts/httpd.mjs', 'build'], {cwd: root, encoding: 'utf8'}),
        close: () => rmSync(root, {recursive: true, force: true})};
}

test('HTTP build prepares upstream libraries before building and selecting a release', () => {
    const f = fixture(0);
    try {
        const result = f.run(); assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(path.join(f.root, 'order.txt'), 'utf8'), 'libraries\nhttp\n');
        assert.equal(JSON.parse(readFileSync(path.join(f.root, 'release/httpd/current.json'))).id, 'next');
    } finally {f.close();}
});

test('failed upstream libraries prevent HTTP build and preserve the previously selected release', () => {
    const f = fixture(7);
    try {
        const result = f.run(); assert.notEqual(result.status, 0);
        assert.equal(readFileSync(path.join(f.root, 'order.txt'), 'utf8'), 'libraries\n');
        assert.equal(JSON.parse(readFileSync(path.join(f.root, 'release/httpd/current.json'))).id, 'previous');
        assert.equal(existsSync(path.join(f.root, 'release/httpd/next')), false);
    } finally {f.close();}
});
