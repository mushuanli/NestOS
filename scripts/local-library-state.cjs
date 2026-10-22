const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const localRoot = root => path.join(root, 'release', 'local-libraries');
const activeFile = root => path.join(localRoot(root), 'active.json');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const snapshotIdentity = packages => createHash('sha256').update(JSON.stringify(packages.map(({ name, version, file, sha256, sourceHash, buildHash, libraryDependencies }) =>
    ({ name, version, file, sha256, ...(sourceHash && { sourceHash }), ...(buildHash && { buildHash }),
        ...(libraryDependencies && { libraryDependencies }) })).sort((a, b) => a.name.localeCompare(b.name)))).digest('hex');

function readSelection(root, choice = process.env.MINDOS_LIBRARY_SNAPSHOT) {
    if (choice === 'source') return null;
    if (!choice && !fs.existsSync(activeFile(root))) return null;
    if (!choice) {
        const active = JSON.parse(fs.readFileSync(activeFile(root), 'utf8'));
        if (active.format !== 1) throw new Error('LOCAL_LIBRARIES_ACTIVE_FORMAT: unsupported selection');
        if (active.mode === 'source') return null;
        if (active.mode !== 'snapshot') throw new Error('LOCAL_LIBRARIES_ACTIVE_FORMAT: invalid mode');
        choice = active.id;
    }
    return readSnapshot(root, choice);
}

function readSnapshot(root, id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('LOCAL_LIBRARIES_ID: invalid snapshot identity');
    const directory = path.join(localRoot(root), 'snapshots', id);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'snapshot.json'), 'utf8'));
    if (manifest.format !== 1 || manifest.id !== id || !Array.isArray(manifest.packages) || !manifest.packages.length) throw new Error('LOCAL_LIBRARIES_MANIFEST: invalid snapshot');
    if (snapshotIdentity(manifest.packages) !== id) throw new Error('LOCAL_LIBRARIES_IDENTITY: snapshot contents do not match identity');
    const names = new Set();
    for (const item of manifest.packages) {
        if (typeof item.name !== 'string' || typeof item.version !== 'string' || names.has(item.name) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('LOCAL_LIBRARIES_MANIFEST: invalid package identity');
        if (['sourceHash', 'buildHash'].some(key => item[key] !== undefined && !/^[a-f0-9]{64}$/.test(item[key]))) throw new Error('LOCAL_LIBRARIES_MANIFEST: invalid build fingerprint');
        if (item.libraryDependencies !== undefined && (!Array.isArray(item.libraryDependencies) || item.libraryDependencies.some(name => typeof name !== 'string'))) throw new Error('LOCAL_LIBRARIES_MANIFEST: invalid library dependency graph');
        names.add(item.name);
        if (typeof item.file !== 'string' || !/^packages\/[a-zA-Z0-9._-]+\.tgz$/.test(item.file)) throw new Error('LOCAL_LIBRARIES_PATH: invalid artifact path');
        if (hash(path.join(directory, item.file)) !== item.sha256) throw new Error(`LOCAL_LIBRARIES_INTEGRITY: ${item.name}`);
    }
    const catalogFile = path.join(root, 'scripts', 'npm-libraries.json');
    const catalog = fs.existsSync(catalogFile) ? JSON.parse(fs.readFileSync(catalogFile, 'utf8')) : [];
    if (catalog.some(item => !names.has(item.name))) throw new Error('LOCAL_LIBRARIES_INCOMPLETE: missing library artifacts');
    return { ...manifest, directory, lockfileDir: path.join(localRoot(root), 'locks', id),
        virtualStoreDir: path.join(root, 'node_modules', '.pnpm-libraries', id) };
}

function snapshotOverrides(snapshot) {
    return Object.fromEntries(snapshot.packages.map(item => [item.name, 'file:' + path.join(snapshot.directory, item.file)]));
}

module.exports = { localRoot, activeFile, readSelection, readSnapshot, snapshotIdentity, snapshotOverrides };
