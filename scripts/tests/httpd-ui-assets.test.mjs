import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {retainUiAssets} from '../httpd-ui-assets.mjs';
import {treeRecords} from '../httpd-build-cache.mjs';

function fixture(t) {
    const root = mkdtempSync(path.join(tmpdir(), 'http-ui-generations-'));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const staging = path.join(root, '.building-test'); mkdirSync(path.join(staging, 'dist/assets'), {recursive: true});
    writeFileSync(path.join(staging, 'dist/assets/current-abcdefgh.js'), 'export const version = "new";');
    const release = (stamp, name, extra = {}) => {
        const id = `${stamp}-12345678`, directory = path.join(root, id);
        mkdirSync(path.join(directory, 'dist/assets'), {recursive: true});
        writeFileSync(path.join(directory, `dist/assets/${name}-abcdefgh.js`), `export const version = "${name}";`);
        writeFileSync(path.join(directory, 'dist/index.html'), 'Old HTML');
        const files = treeRecords(directory, 'dist');
        writeFileSync(path.join(directory, 'release.json'), JSON.stringify({files, ...extra}));
        return {id, directory, files};
    };
    return {root, staging, release};
}
test('retains selected and preceding source assets, excludes HTML and bounds generations', t => {
    const f = fixture(t); f.release('20260101T000000', 'oldest'); f.release('20260102T000000', 'previous');
    const selected = f.release('20260103T000000', 'selected');
    writeFileSync(path.join(f.root, 'current.json'), JSON.stringify({id: selected.id}));
    const result = retainUiAssets(f.root, f.staging);
    assert.equal(result.generations, 2); assert.equal(result.retained, 2); assert.equal(result.uiAssets.length, 1);
    assert.equal(readFileSync(path.join(f.staging, 'dist/assets/selected-abcdefgh.js'), 'utf8'), 'export const version = "selected";');
    const outputs = treeRecords(f.staging, 'dist').map(row => row.file);
    assert.ok(!outputs.some(file => /oldest|index.html/.test(file)));
});
test('does not perpetuate assets already retained by another release', t => {
    const f = fixture(t), previous = f.release('20260102T000000', 'previous', {uiAssets: []});
    const selected = f.release('20260103T000000', 'selected', {uiAssets: []});
    writeFileSync(path.join(f.root, 'current.json'), JSON.stringify({id: selected.id}));
    assert.equal(retainUiAssets(f.root, f.staging).retained, 0);
    assert.ok(previous.files.length > 0);
});
test('rejects tampered retained output rather than serving it under an immutable asset URL', t => {
    const f = fixture(t), prior = f.release('20260103T000000', 'previous');
    writeFileSync(path.join(prior.directory, 'dist/assets/previous-abcdefgh.js'), 'changed after manifest');
    assert.throws(() => retainUiAssets(f.root, f.staging), {code: 'HTTP_ASSET_INTEGRITY'});
});
