import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse } from 'yaml';

const fields = ['dependencies', 'devDependencies', 'optionalDependencies'];
const hash = value => createHash('sha256').update(value).digest('hex');
const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const encode = value => JSON.stringify(sorted(value));
const without = (value, keys) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));
const packageName = key => key.slice(0, key.indexOf('@', 1) < 0 ? key.length : key.indexOf('@', 1));
const entries = importer => fields.flatMap(field => Object.entries(importer?.[field] ?? {}))
    .sort((a, b) => encode(a).localeCompare(encode(b)));
const error = (code, detail) => Object.assign(new Error(`${code}: ${detail}`), { code });

function readYAML(root, file) {
    try { return parse(readFileSync(join(root, file), 'utf8')) ?? {}; }
    catch { throw error('LOCAL_LIBRARIES_YAML_INPUT', `cannot read or parse ${file}`); }
}

export function buildSupportFiles(root) {
    const manifest = readJSON(join(root, 'package.json')), workspace = readYAML(root, 'pnpm-workspace.yaml');
    const patches = { ...manifest.pnpm?.patchedDependencies, ...workspace.patchedDependencies };
    const files = [...new Set(Object.values(patches).map(patch => typeof patch === 'string' ? patch : patch.path))].sort();
    if (files.some(file => typeof file !== 'string' || isAbsolute(file) || file.split(/[\\/]/).includes('..')))
        throw error('LOCAL_LIBRARIES_PATCH_PATH', 'patch files must be inside the workspace');
    return [...(existsSync(join(root, '.npmrc')) ? ['.npmrc'] : []), ...files];
}

/** Hash shared mechanisms, rather than root scripts or unrelated workspace manifests. */
function sharedInputs(root, manifest, workspace, lock) {
    const files = ['tsconfig.base.json', '.npmrc', 'scripts/library-artifacts.mjs', 'scripts/npm-libraries.mjs',
        'scripts/build-source-policy.mjs', 'scripts/local-library-build.mjs', 'scripts/local-library-plan.mjs', 'scripts/local-library-inputs.mjs'];
    return {
        format: 2, packageManager: manifest.packageManager, engines: manifest.engines,
        runtime: [process.version, process.platform, process.arch, process.versions.modules],
        pnpm: without(manifest.pnpm, ['overrides', 'patchedDependencies', 'packageExtensions']),
        workspace: without(workspace, ['packages', 'overrides', 'patchedDependencies', 'packageExtensions', 'catalog', 'catalogs']),
        lockfileVersion: lock.lockfileVersion, settings: lock.settings,
        files: files.map(file => [file, existsSync(join(root, file)) ? hash(readFileSync(join(root, file))) : null]),
    };
}

function importerInputs(lock, importer, manifest, internal) {
    const declared = entries(manifest).filter(([name]) => !internal.has(name));
    const actual = entries(lock.importers?.[importer]).filter(([name]) => !internal.has(name));
    const stale = declared.some(([name, specifier]) => !actual.some(([key, row]) => key === name && row.specifier === specifier));
    // Preserve first builds and edits before pnpm install, but never claim a precise dependency graph for a stale importer.
    return { declared, importer: actual, fallback: stale ? hash(encode(lock)) : undefined };
}

function dependencyKey(lock, name, reference) {
    const candidates = [`${name}@${reference}`, reference];
    const key = candidates.find(value => Object.hasOwn(lock.snapshots ?? {}, value));
    if (!key) throw error('LOCAL_LIBRARIES_LOCK_REFERENCE', `missing snapshot for ${name}`);
    return key;
}

function dependencyGraph(lock, importers) {
    const records = new Map(), pending = importers.flatMap(item => item.importer.map(([name, row]) => [name, row.version]));
    while (pending.length) {
        const [name, reference] = pending.pop();
        const key = dependencyKey(lock, name, reference);
        if (records.has(key)) continue;
        const snapshot = lock.snapshots[key], metadata = lock.packages?.[key.split('(')[0]];
        if (!metadata) throw error('LOCAL_LIBRARIES_LOCK_PACKAGE', `missing package metadata for ${name}`);
        records.set(key, { snapshot, metadata });
        pending.push(...Object.entries(snapshot.dependencies ?? {}), ...Object.entries(snapshot.optionalDependencies ?? {}));
    }
    return Object.fromEntries([...records].sort(([a], [b]) => a.localeCompare(b)));
}

function relevantRules(rules, names) {
    return Object.fromEntries(Object.entries(rules ?? {}).filter(([selector]) =>
        selector.split('>').some(part => names.has(packageName(part.trim())))));
}

function resolutionInputs(root, manifest, workspace, lock, graph, importers) {
    const aliases = [...importers.flatMap(item => item.importer.map(([name]) => name)),
        ...Object.values(graph).flatMap(({ snapshot }) => entries(snapshot).map(([name]) => name))];
    const names = new Set([...Object.keys(graph).map(packageName), ...aliases]);
    const configurations = [manifest.pnpm, workspace, lock];
    const patches = relevantRules({ ...manifest.pnpm?.patchedDependencies, ...workspace.patchedDependencies }, names);
    return {
        overrides: configurations.map(config => relevantRules(config?.overrides, names)),
        extensions: configurations.map(config => relevantRules(config?.packageExtensions, names)),
        patches: configurations.map(config => relevantRules(config?.patchedDependencies, names)),
        patchFiles: Object.entries(patches).sort(([a], [b]) => a.localeCompare(b)).map(([name, patch]) => {
            const file = typeof patch === 'string' ? patch : patch.path;
            return [name, patch, hash(readFileSync(join(root, file)))];
        }),
    };
}

function catalogInputs(workspace, importers) {
    return importers.flatMap(item => item.declared.filter(([, spec]) => spec.startsWith('catalog:')).map(([name, spec]) => {
        const catalog = spec.slice('catalog:'.length);
        return [name, catalog, catalog ? workspace.catalogs?.[catalog]?.[name] : workspace.catalog?.[name]];
    }));
}

/** Read YAML once per plan; each library watches its own resolved dependency closure plus root tooling. */
export function libraryBuildInputs(root, catalog) {
    const manifest = readJSON(join(root, 'package.json'));
    const workspace = readYAML(root, 'pnpm-workspace.yaml'), lock = readYAML(root, 'pnpm-lock.yaml');
    if (String(lock.lockfileVersion) !== '9.0' && String(lock.lockfileVersion) !== '9')
        throw error('LOCAL_LIBRARIES_LOCK_VERSION', 'expected pnpm lockfile version 9');
    const internal = new Set(catalog.map(item => item.name)), shared = sharedInputs(root, manifest, workspace, lock);
    const tooling = importerInputs(lock, '.', manifest, internal);
    return library => {
        const source = readJSON(join(root, 'libraries', library.directory, 'package.json'));
        const importers = [tooling, importerInputs(lock, `libraries/${library.directory}`, source, internal)];
        const graph = dependencyGraph(lock, importers);
        return hash(encode({ shared, importers, graph, resolution: resolutionInputs(root, manifest, workspace, lock, graph, importers),
            catalogs: catalogInputs(workspace, importers),
            fallback: importers.some(item => item.fallback) ? { workspace, pnpm: manifest.pnpm } : undefined }));
    };
}
