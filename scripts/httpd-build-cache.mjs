import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));
export const fileHash = file => digest(readFileSync(file));
const safe = file => typeof file === 'string' && file && !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..');
export function cloneTree(from, to) {
    mkdirSync(path.dirname(to), {recursive: true});
    cpSync(from, to, {recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE});
}
export function treeRecords(directory, prefix = '') {
    return readdirSync(path.join(directory, prefix), {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
        const file = path.join(prefix, entry.name), target = path.join(directory, file);
        if (entry.isSymbolicLink()) throw new Error(`HTTP_CACHE_OUTPUT_SYMLINK: ${file}`);
        return entry.isDirectory() ? treeRecords(directory, file) : [{file, sha256: fileHash(target)}];
    });
}
export function buildEnvironment(env = process.env) {
    return Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('VITE_')
        || ['NODE_ENV', 'NODE_OPTIONS', 'ESBUILD_BINARY_PATH', 'BROWSERSLIST', 'BROWSERSLIST_ENV'].includes(key)).sort());
}
export function dependencyInputs(files) {
    return files.filter(file => /(^|\/)package\.json$/.test(file) || /(^|\/)(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.cjs)$/.test(file)
        || file.startsWith('scripts/local-library-state.'));
}
export function artifactContext(source, files, dependencyKey, environment) {
    const configuration = files.filter(file => file.startsWith('scripts/') || /(^|\/)(?:package\.json|tsconfig[^/]*\.json|[^/]*(?:vite|tsup)\.config\.[^/]+)$/.test(file)
        || file.endsWith('.html') || file.includes('/public/'));
    return digest(JSON.stringify({format: 1, dependencyKey, environment, names: files,
        configuration: configuration.map(file => [file, fileHash(path.join(source, file))])}));
}
/** Watch actual compiler inputs, with relative names independent of the build directory. */
export function graphInputs(source, files) {
    return [...new Set(files.map(file => file.split('?')[0]).filter(file => path.isAbsolute(file) && existsSync(file))
        .map(file => realpathSync(file)).filter(file => !file.includes(`${path.sep}node_modules${path.sep}`))
        .map(file => {
            const relative = path.relative(source, file);
            if (!safe(relative)) throw new Error('HTTP_CACHE_INPUT_OUTSIDE_CAPTURE');
            return relative;
        }))].sort();
}
export function restoreArtifact(directory, output, source, context) {
    try {
        const receipt = readJSON(path.join(directory, 'cache.json'));
        if (receipt.format !== 1 || receipt.context !== context) return {hit: false, reason: 'context-changed'};
        if (!receipt.inputs?.length || !receipt.outputs?.length) return {hit: false, reason: 'incomplete'};
        for (const row of receipt.inputs) if (!safe(row.file) || fileHash(path.join(source, row.file)) !== row.sha256)
            return {hit: false, reason: 'input-changed'};
        const actual = treeRecords(path.join(directory, 'output'));
        if (JSON.stringify(actual) !== JSON.stringify(receipt.outputs)) return {hit: false, reason: 'output-changed'};
        cloneTree(path.join(directory, 'output'), output);
        return {hit: true, inputs: receipt.inputs.map(row => row.file)};
    } catch (error) { return {hit: false, reason: error.code === 'ENOENT' ? 'missing' : 'invalid-cache'}; }
}
export function storeArtifact(directory, output, source, context, inputs) {
    if (!inputs.length) throw new Error('HTTP_CACHE_INPUTS_EMPTY');
    const temporary = `${directory}.writing-${randomUUID()}`;
    try {
        cloneTree(output, path.join(temporary, 'output'));
        writeFileSync(path.join(temporary, 'cache.json'), JSON.stringify({format: 1, context,
            inputs: inputs.map(file => ({file, sha256: fileHash(path.join(source, file))})), outputs: treeRecords(output)}));
        rmSync(directory, {recursive: true, force: true}); renameSync(temporary, directory);
    } finally { rmSync(temporary, {recursive: true, force: true}); }
}
/** Serialize captures because cached node_modules links refer to this stable workspace. */
export function acquireBuildLock(directory) {
    mkdirSync(directory, {recursive: true});
    const lock = path.join(directory, 'lock');
    try { mkdirSync(lock); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = readJSON(path.join(lock, 'owner.json')); }
        catch { throw new Error('HTTP_BUILD_BUSY: build lock owner is not available'); }
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('HTTP_BUILD_BUSY: invalid build lock owner');
        try { process.kill(owner.pid, 0); }
        catch (probe) { if (probe.code !== 'ESRCH') throw probe; rmSync(lock, {recursive: true}); return acquireBuildLock(directory); }
        throw new Error(`HTTP_BUILD_BUSY: build process ${owner.pid} is still running`);
    }
    writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({pid: process.pid}));
    return () => rmSync(lock, {recursive: true, force: true});
}
