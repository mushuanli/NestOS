import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { libraries } from './npm-libraries.mjs';
import { packBuiltLibrary } from './library-artifacts.mjs';
import { excluded, sourceHash, buildHash, preparedSnapshot, planSnapshot } from './local-library-plan.mjs';
import state from './local-library-state.mjs';

function captureLibrary(root, work, library, plan) {
    const target = join(work, 'libraries', library.directory);
    mkdirSync(target, { recursive: true });
    if (!plan.selected.includes(library.name)) {
        const previous = plan.base.packages.find(item => item.name === library.name);
        execFileSync('tar', ['-xzf', join(plan.base.directory, previous.file), '--strip-components=1', '-C', target]);
        return;
    }
    const source = join(root, 'libraries', library.directory);
    cpSync(source, target, { recursive: true, filter: file => !excluded.has(basename(file)) });
    if (library.sourceHash !== sourceHash(source) || library.sourceHash !== sourceHash(target))
        throw new Error(`LOCAL_LIBRARIES_SOURCE_CHANGED: retry capture of ${library.name}`);
}
function captureSources(root, work, plan) {
    for (const library of plan.records) captureLibrary(root, work, library, plan);
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    delete manifest.scripts;
    writeFileSync(join(work, 'package.json'), JSON.stringify(manifest, null, 2));
    for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json']) cpSync(join(root, file), join(work, file));
    if (buildHash(root) !== plan.buildHash) throw new Error('LOCAL_LIBRARIES_BUILD_INPUT_CHANGED: retry after saving build configuration');
}
function buildCaptured(work, log, selected) {
    log('install', () => execFileSync('pnpm', ['install', '--prefer-offline', '--no-frozen-lockfile', '--ignore-scripts'], {
        cwd: work, stdio: 'inherit', env: { ...process.env, MINDOS_LIBRARY_SNAPSHOT: 'source', CI: 'true' },
    }));
    const filters = selected.flatMap(name => ['--filter', name]);
    log('build', () => execFileSync('pnpm', ['-r', '--workspace-concurrency=1', ...filters, 'build'], {
        cwd: work, stdio: 'inherit', env: { ...process.env, MINDOS_LIBRARY_SNAPSHOT: 'source' },
    }));
}
function packCaptured(work, output, plan) {
    const versions = new Map(plan.records.map(item => [item.name, item.version]));
    mkdirSync(join(output, 'packages'), { recursive: true });
    return plan.records.map(library => {
        if (!plan.selected.includes(library.name)) {
            const previous = plan.base.packages.find(item => item.name === library.name);
            cpSync(join(plan.base.directory, previous.file), join(output, previous.file));
            return previous;
        }
        const artifact = packBuiltLibrary(library, join(work, 'libraries', library.directory), output, versions);
        const file = `packages/${library.directory}.tgz`;
        renameSync(artifact.tarball, join(output, file));
        const { name, directory, version, sourceHash, buildHash, libraryDependencies } = library;
        return { name, directory, version, file, sha256: artifact.sha256, sourceHash, buildHash, libraryDependencies };
    });
}
function saveSnapshot(root, output, packages) {
    const id = state.snapshotIdentity(packages), destination = join(state.localRoot(root), 'snapshots', id);
    writeFileSync(join(output, 'snapshot.json'), JSON.stringify({ format: 1, id, createdAt: new Date().toISOString(), packages }, null, 2) + '\n');
    rmSync(join(output, 'staging'), { recursive: true, force: true });
    mkdirSync(join(state.localRoot(root), 'snapshots'), { recursive: true });
    if (!existsSync(destination)) renameSync(output, destination);
    return state.readSnapshot(root, id);
}
export function prepareSnapshot(root, operationId, log, { incremental = false, requested } = {}) {
    const base = incremental ? preparedSnapshot(root) : null;
    const plan = log('plan', () => planSnapshot(root, libraries, { base, requested, full: !incremental }));
    console.log(`[local-libraries] operationId=${operationId} stage=plan result=success base=${base?.id ?? 'none'} rebuild=${plan.selected.length} reuse=${plan.records.length - plan.selected.length} libraries=${plan.selected.join(',')}`);
    if (!plan.selected.length) return base;
    const work = join(state.localRoot(root), 'work', operationId), output = join(work, 'artifact');
    mkdirSync(work, { recursive: true });
    try {
        log('capture', () => captureSources(root, join(work, 'source'), plan));
        buildCaptured(join(work, 'source'), log, plan.selected);
        const packages = log('pack', () => packCaptured(join(work, 'source'), output, plan));
        return saveSnapshot(root, output, packages);
    } finally { rmSync(work, { recursive: true, force: true }); }
}
