import {isHttpBuildSource} from './build-source-policy.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { copyLibrarySnapshot, copyNativeRuntimes, copySource, freezeWorkspaceDependencies, sourceFiles, sourceFingerprint, verifyRelease } from './httpd-runtime.mjs';
import { acquireBuildLock, artifactContext, buildEnvironment, dependencyInputs, digest, fileHash, graphInputs, readJSON, restoreArtifact, storeArtifact, treeRecords } from './httpd-build-cache.mjs';
import state from './local-library-state.mjs';
import { preparedSnapshot } from './local-library-plan.mjs';

const run = (command, args, cwd, env = process.env) => execFileSync(command, args, {cwd, env, stdio: 'inherit'});
const inputsAt = root => {
    const files = sourceFiles(root);
    const toolPackages = new Set(files.filter(file => /^tools\/[^/]+\/package\.json$/.test(file)).map(file => file.slice(0, -'/package.json'.length)));
    return files.filter(file => isHttpBuildSource(file, toolPackages));
};
/** Keep the existing release fence and report paths, never source contents. */
export function captureSourceGuard(root, inputs = inputsAt(root)) {
    const fingerprint = sourceFingerprint(root, inputs);
    const revisions = new Map(inputs.map(file => [file, sourceFingerprint(root, [file])]));
    return {fingerprint, check() {
        const files = inputsAt(root);
        if (fingerprint === sourceFingerprint(root, files)) return;
        const current = new Map(files.map(file => [file, sourceFingerprint(root, [file])]));
        const changedFiles = [...new Set([...revisions.keys(), ...current.keys()])]
            .filter(file => revisions.get(file) !== current.get(file)).sort();
        const details = changedFiles.slice(0, 8).join(', ') || 'inputs changed during initial capture';
        throw Object.assign(new Error(`Business source changed during the build: ${details}. Retry after saving your changes.`),
            {code: 'HTTP_BUILD_SOURCE_CHANGED', changedFiles});
    }};
}
function reporter(operationId) {
    return (stage, work) => {
        const started = Date.now(); console.log(`[HTTPBuild] operationId=${operationId} stage=${stage} result=start`);
        try { const result = work(); console.log(`[HTTPBuild] operationId=${operationId} stage=${stage} result=success durationMs=${Date.now() - started}`); return result; }
        catch (error) { console.error(`[HTTPBuild] operationId=${operationId} stage=${stage} result=failure durationMs=${Date.now() - started} code=${error.code ?? error.status ?? 'HTTP_BUILD_FAILED'}`); throw error; }
    };
}
function nativeFingerprint(app) {
    const hash = createHash('sha256');
    function visit(directory) {
        if (!existsSync(directory)) return;
        for (const entry of readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
            if (['obj', 'obj.target', '.deps'].includes(entry.name) || entry.name.endsWith('.o')) continue;
            const file = path.join(directory, entry.name); hash.update(entry.name);
            if (entry.isDirectory()) visit(file); else hash.update(readFileSync(file));
        }
    }
    for (const name of ['better-sqlite3', 'node-pty', 'sharp']) {
        const directory = realpathSync(path.join(app, 'node_modules', name));
        hash.update(readFileSync(path.join(directory, 'package.json')));
        if (name !== 'sharp') visit(path.join(directory, 'build/Release'));
    }
    return hash.digest('hex');
}
function installationHit(directory, key) {
    try {
        const receipt = readJSON(path.join(directory, 'installed.json'));
        return receipt.key === key && receipt.lock === fileHash(path.join(directory, 'installed-lock.yaml'))
            && receipt.modules === fileHash(path.join(directory, 'source/node_modules/.modules.yaml'))
            && existsSync(path.join(directory, 'source/node_modules/.bin/vite')) && existsSync(path.join(directory, 'source/node_modules/.bin/tsup'));
    } catch { return false; }
}
function capture(root, source, inputs) {
    const file = path.join(source, '.httpd-captured.json');
    const previous = existsSync(file) ? readJSON(file) : [];
    for (const old of previous) if (!inputs.includes(old)) rmSync(path.join(source, old), {force: true});
    for (const input of inputs) {
        const target = path.join(source, input);
        if (existsSync(target) && lstatSync(target).isSymbolicLink()) rmSync(target);
    }
    copySource(root, source, inputs);
    writeFileSync(file, JSON.stringify(inputs));
}
function workspace(context) {
    const {root, cacheDirectory, dependencyKey, inputs, snapshot, cache, stage, env} = context;
    const directory = path.join(cacheDirectory, 'dependencies', cache ? dependencyKey : randomUUID());
    const source = path.join(directory, 'source'), hit = cache && installationHit(directory, dependencyKey);
    if (!hit) rmSync(directory, {recursive: true, force: true});
    stage('capture', () => { capture(root, source, inputs); if (!hit) copyLibrarySnapshot(root, source, snapshot); });
    state.readSelection(source);
    const manifest = path.join(source, 'apps/http-app/package.json');
    const pkg = readJSON(manifest); pkg.dependencies = {...pkg.dependencies, ...state.snapshotOverrides(state.readSelection(source))};
    writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`[HTTPBuild] operationId=${context.operationId} stage=install cache=${hit ? 'hit' : 'miss'}`);
    stage('install', () => {
        if (hit) writeFileSync(path.join(source, 'pnpm-lock.yaml'), readFileSync(path.join(directory, 'installed-lock.yaml')));
        else {
            run('pnpm', ['install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'], source, env);
            writeFileSync(path.join(directory, 'installed-lock.yaml'), readFileSync(path.join(source, 'pnpm-lock.yaml')));
            writeFileSync(path.join(directory, 'installed.json'), JSON.stringify({key: dependencyKey,
                lock: fileHash(path.join(directory, 'installed-lock.yaml')), modules: fileHash(path.join(source, 'node_modules/.modules.yaml'))}));
        }
    });
    return {source, directory};
}
function assertDependencies(directory, snapshot, visited = new Set()) {
    const actual = realpathSync(directory); if (visited.has(actual)) return; visited.add(actual);
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
        const file = path.join(directory, entry.name);
        if (!lstatSync(file).isSymbolicLink()) { if (entry.isDirectory()) assertDependencies(file, snapshot, visited); continue; }
        const relative = path.relative(snapshot, realpathSync(file));
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error(`External release dependency: ${file}`);
    }
}
function deployment(context, source, staging) {
    context.stage('deploy', () => {
        run('pnpm', ['--config.package-import-method=copy', '--config.offline=true', '--ignore-scripts', '--filter', '@itookit/http-app', 'deploy', '--prod', '--legacy', staging], source, context.env);
        freezeWorkspaceDependencies(staging); copyNativeRuntimes(path.join(context.root, 'apps/http-app'), staging);
        run(process.execPath, [path.join(context.root, 'scripts/check-node-native-runtime.mjs'), staging], staging);
        for (const entry of readdirSync(staging)) if (!['package.json', 'node_modules'].includes(entry)) rmSync(path.join(staging, entry), {recursive: true, force: true});
    });
}
function compile(context, source, staging, kind) {
    const {cacheDirectory, dependencyKey, environment, inputs, cache, stage, operationId, env} = context;
    const directory = path.join(cacheDirectory, 'artifacts', kind), output = path.join(staging, kind === 'ui' ? 'dist' : 'server');
    const common = artifactContext(source, inputs, dependencyKey, environment);
    const restored = cache ? restoreArtifact(directory, output, source, common) : {hit: false, reason: 'disabled'};
    console.log(`[HTTPBuild] operationId=${operationId} stage=${kind} cache=${restored.hit ? 'hit' : 'miss'} reason=${restored.reason ?? 'validated'}`);
    stage(kind, () => {
        if (restored.hit) return;
        const app = path.join(source, 'apps/http-app'), graph = path.join(source, '.httpd-ui-inputs.json');
        let files;
        if (kind === 'ui') {
            run('pnpm', ['exec', 'vite', 'build', '--outDir', output, '--emptyOutDir'], app, {...env, NESTOS_HTTPD_BUILD_GRAPH: graph});
            files = readJSON(graph); rmSync(graph);
        } else {
            run('pnpm', ['exec', 'tsup', 'src/server/main.ts', '--format', 'esm', '--platform', 'node', '--out-dir', output, '--splitting', '--clean', '--metafile'], app, env);
            const metafile = path.join(output, 'metafile-esm.json');
            const metadata = readJSON(metafile);
            files = Object.keys(metadata.inputs).map(file => path.resolve(app, file));
            const external = [...new Set(Object.values(metadata.outputs).flatMap(output => output.imports.filter(item => item.external).map(item => item.path)))].sort();
            writeFileSync(path.join(output, 'runtime-dependencies.json'), JSON.stringify(external, null, 2) + '\n');
            rmSync(metafile);
        }
        if (cache) storeArtifact(directory, output, source, common, graphInputs(source, files));
    });
}
function reuseRelease(releases, key) {
    for (const pointer of ['current.json', '.build-cache/last-release.json']) {
        try {
            const id = readJSON(path.join(releases, pointer)).id;
            if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(id)) continue;
            const directory = path.join(releases, id), manifest = verifyRelease(directory);
            if (manifest.buildKey === key && existsSync(path.join(directory, 'node_modules'))) return id;
        } catch { /* A removed or modified release is rebuilt. */ }
    }
}
function buildRelease(context, activate) {
    const {root, releases, snapshot, stage, fingerprint, key, commit, dirty, cache, operationId} = context;
    const reused = cache && reuseRelease(releases, key);
    if (reused) {
        stage('validate-reuse', () => run(process.execPath, [path.join(releases, reused, 'server/main.js'), '--help'], path.join(releases, reused)));
        context.sourceGuard.check();
        if (activate) activate(reused);
        console.log(`[HTTPBuild] operationId=${operationId} stage=release cache=hit id=${reused}`); return reused;
    }
    const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '') + '-' + commit.slice(0, 8) + (dirty ? '-dirty' : '');
    const staging = path.join(releases, '.building-' + operationId);
    let captured;
    try {
        captured = workspace(context); deployment(context, captured.source, staging);
        compile(context, captured.source, staging, 'ui'); compile(context, captured.source, staging, 'server');
        stage('validate', () => {
            assertDependencies(path.join(staging, 'node_modules'), staging);
            run(process.execPath, [path.join(staging, 'server/main.js'), '--help'], staging);
            context.sourceGuard.check();
        });
        const files = ['server', 'dist'].flatMap(folder => treeRecords(staging, folder));
        writeFileSync(path.join(staging, 'release.json'), JSON.stringify({id, commit, dirty, builtAt: new Date().toISOString(),
            buildKey: key, librarySnapshot: snapshot.id, nodeMajor: Number(process.versions.node.split('.')[0]), files}, null, 2) + '\n');
        renameSync(staging, path.join(releases, id)); if (activate) activate(id);
        writeFileSync(path.join(context.cacheDirectory, 'last-release.json'), JSON.stringify({id}));
        return id;
    } finally { rmSync(staging, {recursive: true, force: true}); if (!cache && captured) rmSync(captured.directory, {recursive: true, force: true}); }
}
export function buildHttpRelease(root, {cache = true, activate} = {}) {
    const releases = path.join(root, 'release/httpd'), cacheDirectory = path.join(releases, '.build-cache');
    const unlock = acquireBuildLock(cacheDirectory), operationId = randomUUID(), stage = reporter(operationId);
    try { return stage('total', () => {
        const snapshot = preparedSnapshot(root);
        if (!snapshot) throw new Error('LOCAL_LIBRARIES_SNAPSHOT_REQUIRED: run pnpm lib:build first');
        console.log(`HTTP build libraries: ${snapshot.id}`);
        const inputs = inputsAt(root), sourceGuard = captureSourceGuard(root, inputs), fingerprint = sourceGuard.fingerprint, environment = buildEnvironment();
        const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
        const dirty = !!execFileSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'}).trim();
        const pnpm = execFileSync('pnpm', ['--version'], {cwd: root, encoding: 'utf8'}).trim();
        const dependencyKey = digest(JSON.stringify({format: 1, snapshot: snapshot.id, node: process.version, abi: process.versions.modules,
            platform: process.platform, arch: process.arch, pnpm, native: nativeFingerprint(path.join(root, 'apps/http-app')),
            inputs: sourceFingerprint(root, dependencyInputs(inputs))}));
        const key = digest(JSON.stringify({fingerprint, dependencyKey, environment, commit, dirty}));
        return buildRelease({root, releases, cacheDirectory, snapshot, inputs, fingerprint, environment, dependencyKey, key,
            cache, stage, sourceGuard, operationId, commit, dirty, env: {...process.env, NESTOS_LIBRARY_DEPLOYMENT: '1'}}, activate);
    }); } finally { unlock(); }
}
