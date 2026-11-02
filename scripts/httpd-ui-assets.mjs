import path from 'node:path';
import {copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync} from 'node:fs';
import {fileHash, readJSON, treeRecords} from './httpd-build-cache.mjs';

const releaseId = /^\d{8}T\d{6}-[a-f0-9]{8}(?:-dirty)?$/;
const hashedAsset = row => /^dist\/assets\/[\w.-]+-[\w-]{8,}\.[\w.]+$/.test(row.file);

/** Preserve two source generations, never recursively copy their retained assets or HTML. */
export function retainUiAssets(releases, staging, limit = 2) {
    const uiAssets = treeRecords(staging, 'dist').filter(hashedAsset);
    const available = new Map(uiAssets.map(row => [row.file, row.sha256]));
    let selected;
    try {selected = readJSON(path.join(releases, 'current.json')).id;} catch { /* First build has no selected release. */ }
    const candidates = readdirSync(releases, {withFileTypes: true}).filter(entry => entry.isDirectory() && releaseId.test(entry.name))
        .map(entry => entry.name).sort().reverse();
    const sources = [...new Set([selected, ...candidates].filter(id => typeof id === 'string' && releaseId.test(id)))].slice(0, limit);
    let retained = 0;
    for (const id of sources) {
        const directory = path.join(releases, id), manifest = readJSON(path.join(directory, 'release.json'));
        for (const row of (manifest.uiAssets ?? manifest.files).filter(hashedAsset)) {
            const source = path.join(directory, row.file), destination = path.join(staging, row.file);
            const relative = path.relative(realpathSync(directory), realpathSync(source));
            if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
                || !lstatSync(source).isFile() || fileHash(source) !== row.sha256) throw assetError('HTTP_ASSET_INTEGRITY');
            if (available.has(row.file)) {
                if (available.get(row.file) !== row.sha256) throw assetError('HTTP_ASSET_HASH_CONFLICT');
                continue;
            }
            if (existsSync(destination)) throw assetError('HTTP_ASSET_PATH_CONFLICT');
            mkdirSync(path.dirname(destination), {recursive: true}); copyFileSync(source, destination);
            available.set(row.file, row.sha256); retained++;
        }
    }
    return {uiAssets, retained, generations: sources.length};
}
function assetError(code) {return Object.assign(new Error(code), {code});}
