import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { planSnapshot } from '../local-library-plan.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const catalog = ['core', 'parent', 'leaf', 'other'].map(directory => ({ name: `@itookit/${directory}`, directory }));
const all = catalog.map(item => item.name);
const dependentNames = all.slice(0, 3);
const locked = (version, specifier = version) => ({ specifier, version });

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'library-plan-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    cpSync(join(repository, 'scripts'), join(root, 'scripts'), { recursive: true });
    const write = (file, data) => {
        mkdirSync(join(root, file, '..'), { recursive: true });
        writeFileSync(join(root, file), file.endsWith('.yaml') ? stringify(data) : JSON.stringify(data));
    };
    write('package.json', { packageManager: 'pnpm@10.20.0', devDependencies: { compiler: '1.0.0' } });
    write('pnpm-workspace.yaml', { packages: ['libraries/*', 'apps/*'], overrides: { unused: '1.0.0' } });
    write('tsconfig.base.json', { compilerOptions: { target: 'ES2022' } });
    for (const item of catalog) write(`libraries/${item.directory}/package.json`, { name: item.name, version: '1.0.0',
        dependencies: { core: { compat: 'npm:@vendor/sdk@1.0.0' }, parent: { '@itookit/core': 'workspace:*' },
            leaf: { '@itookit/parent': 'workspace:*' }, other: {} }[item.directory] });
    const lock = lockFixture(); write('pnpm-lock.yaml', lock);
    const first = planSnapshot(root, catalog), base = { packages: first.records };
    return { root, lock, write, plan: () => planSnapshot(root, catalog, { base }),
        json: file => JSON.parse(readFileSync(join(root, file), 'utf8')),
        yaml: file => parse(readFileSync(join(root, file), 'utf8')) };
}

function lockFixture() {
    return {
        lockfileVersion: '9.0', settings: { autoInstallPeers: true },
        importers: { '.': { devDependencies: { compiler: locked('1.0.0') } },
            'libraries/core': { dependencies: { compat: locked('@vendor/sdk@1.0.0(peer@1.0.0)', 'npm:@vendor/sdk@1.0.0') } },
            'apps/web': { dependencies: { unrelated: locked('1.0.0') } } },
        packages: Object.fromEntries(['compiler', '@vendor/sdk', 'transitive', 'optional', 'peer', 'unrelated']
            .map(name => [`${name}@1.0.0`, { resolution: { integrity: `${name}-original` } }])),
        snapshots: { 'compiler@1.0.0': {}, '@vendor/sdk@1.0.0(peer@1.0.0)': {
            dependencies: { transitive: '1.0.0', peer: '1.0.0' }, optionalDependencies: { optional: '1.0.0' } },
        'transitive@1.0.0': { dependencies: { compat: '@vendor/sdk@1.0.0(peer@1.0.0)' } },
        'optional@1.0.0': {}, 'peer@1.0.0': {}, 'unrelated@1.0.0': {} },
    };
}

test('business dependency updates, root scripts, workspace members and YAML ordering preserve all artifacts', t => {
    const f = fixture(t);
    f.lock.importers['apps/web'].dependencies.unrelated = locked('2.0.0');
    f.lock.packages['unrelated@2.0.0'] = { resolution: { integrity: 'new-business-dependency' } };
    f.lock.snapshots['unrelated@2.0.0'] = {};
    f.write('pnpm-lock.yaml', Object.fromEntries(Object.entries(f.lock).reverse()));
    f.write('package.json', { ...f.json('package.json'), scripts: { build: 'another command' }, description: 'edited' });
    f.write('pnpm-workspace.yaml', { packages: ['libraries/*', 'apps/*', 'tools/*'], overrides: { unused: '2.0.0' } });
    assert.deepEqual(f.plan().selected, []);
});

for (const name of ['@vendor/sdk', 'transitive', 'optional', 'peer']) {
    test(`${name} resolution metadata changes rebuild only its library and dependents`, t => {
        const f = fixture(t);
        f.lock.packages[`${name}@1.0.0`].resolution.integrity = 'changed';
        f.write('pnpm-lock.yaml', f.lock);
        const plan = f.plan();
        assert.deepEqual(plan.selected, dependentNames);
        assert.deepEqual(plan.reasons['@itookit/core'], ['build-inputs-changed']);
        assert.deepEqual(plan.reasons['@itookit/parent'], ['dependency-rebuilt']);
    });
}

test('peer contexts and transitive version changes follow the resolved snapshot graph', t => {
    const f = fixture(t), key = '@vendor/sdk@1.0.0(peer@2.0.0)';
    f.lock.importers['libraries/core'].dependencies.compat.version = key;
    f.lock.snapshots[key] = { dependencies: { peer: '2.0.0' } };
    f.lock.packages['peer@2.0.0'] = { resolution: { integrity: 'peer-v2' } };
    f.lock.snapshots['peer@2.0.0'] = {};
    f.write('pnpm-lock.yaml', f.lock);
    assert.deepEqual(f.plan().selected, dependentNames);
});

test('root tooling, shared compiler configuration and build mechanisms invalidate every library', t => {
    const f = fixture(t);
    f.lock.packages['compiler@1.0.0'].resolution.integrity = 'updated compiler';
    f.write('pnpm-lock.yaml', f.lock);
    assert.deepEqual(f.plan().selected, all);
    f.lock.packages['compiler@1.0.0'].resolution.integrity = 'compiler-original';
    f.write('pnpm-lock.yaml', f.lock);
    assert.deepEqual(f.plan().selected, []);
    f.write('tsconfig.base.json', { compilerOptions: { target: 'ES2023' } });
    assert.deepEqual(f.plan().selected, all);
    f.write('tsconfig.base.json', { compilerOptions: { target: 'ES2022' } });
    writeFileSync(join(f.root, 'scripts/library-artifacts.mjs'), '// changed build mechanism');
    assert.deepEqual(f.plan().selected, all);
});

test('overrides, patches and catalogs invalidate only libraries that use the affected package', t => {
    const f = fixture(t), workspace = f.yaml('pnpm-workspace.yaml');
    workspace.overrides = { transitive: '2.0.0' };
    f.write('pnpm-workspace.yaml', workspace);
    assert.deepEqual(f.plan().selected, dependentNames);
    delete workspace.overrides;
    workspace.patchedDependencies = { 'transitive@1.0.0': 'patches/transitive.patch' };
    f.write('patches/transitive.patch', 'patch contents'); f.write('pnpm-workspace.yaml', workspace);
    assert.deepEqual(f.plan().selected, dependentNames);
    delete workspace.patchedDependencies;
    workspace.catalog = { unrelated: '2.0.0' }; f.write('pnpm-workspace.yaml', workspace);
    assert.deepEqual(f.plan().selected, []);
});

test('configured overrides are tracked before the lockfile is refreshed, including aliases', t => {
    const f = fixture(t), workspace = f.yaml('pnpm-workspace.yaml');
    f.lock.overrides = { transitive: '1.0.0', compat: 'npm:@vendor/sdk@1.0.0' };
    f.write('pnpm-lock.yaml', f.lock);
    workspace.overrides = { ...f.lock.overrides }; f.write('pnpm-workspace.yaml', workspace);
    const base = { packages: f.plan().records };
    workspace.overrides.transitive = '2.0.0'; f.write('pnpm-workspace.yaml', workspace);
    assert.deepEqual(planSnapshot(f.root, catalog, { base }).selected, dependentNames);
    workspace.overrides.transitive = '1.0.0'; workspace.overrides.compat = 'npm:@vendor/sdk@2.0.0';
    f.write('pnpm-workspace.yaml', workspace);
    assert.deepEqual(planSnapshot(f.root, catalog, { base }).selected, dependentNames);
});

test('used catalog entries and patch bytes are watched independently of lockfile metadata', t => {
    const f = fixture(t), workspace = f.yaml('pnpm-workspace.yaml'), source = f.json('libraries/core/package.json');
    source.dependencies.compat = 'catalog:ui'; f.write('libraries/core/package.json', source);
    f.lock.importers['libraries/core'].dependencies.compat.specifier = 'catalog:ui'; f.write('pnpm-lock.yaml', f.lock);
    workspace.catalogs = { ui: { compat: 'npm:@vendor/sdk@1.0.0', unrelated: '1.0.0' } };
    workspace.patchedDependencies = { 'transitive@1.0.0': 'patches/transitive.patch' };
    f.write('patches/transitive.patch', 'original'); f.write('pnpm-workspace.yaml', workspace);
    const base = { packages: f.plan().records };
    workspace.catalogs.ui.unrelated = '2.0.0'; f.write('pnpm-workspace.yaml', workspace);
    assert.deepEqual(planSnapshot(f.root, catalog, { base }).selected, []);
    workspace.catalogs.ui.compat = 'npm:@vendor/sdk@2.0.0'; f.write('pnpm-workspace.yaml', workspace);
    assert.deepEqual(planSnapshot(f.root, catalog, { base }).selected, dependentNames);
    workspace.catalogs.ui.compat = 'npm:@vendor/sdk@1.0.0'; f.write('pnpm-workspace.yaml', workspace);
    f.write('patches/transitive.patch', 'changed');
    assert.deepEqual(planSnapshot(f.root, catalog, { base }).selected, dependentNames);
});

test('stale external importers conservatively watch the lockfile instead of silently reusing artifacts', t => {
    const f = fixture(t), source = f.json('libraries/other/package.json');
    source.dependencies.newDependency = '^1.0.0'; f.write('libraries/other/package.json', source);
    assert.deepEqual(f.plan().selected, ['@itookit/other']);
    const base = { packages: f.plan().records };
    f.lock.packages['unrelated@1.0.0'].resolution.integrity = 'changed'; f.write('pnpm-lock.yaml', f.lock);
    assert.deepEqual(planSnapshot(f.root, catalog, { base }).selected, ['@itookit/other']);
});

test('missing lock records, unsupported formats and invalid YAML report specific non-sensitive errors', t => {
    const f = fixture(t);
    delete f.lock.snapshots['peer@1.0.0']; f.write('pnpm-lock.yaml', f.lock);
    assert.throws(f.plan, { code: 'LOCAL_LIBRARIES_LOCK_REFERENCE' });
    f.lock.snapshots['peer@1.0.0'] = {}; delete f.lock.packages['peer@1.0.0']; f.write('pnpm-lock.yaml', f.lock);
    assert.throws(f.plan, { code: 'LOCAL_LIBRARIES_LOCK_PACKAGE' });
    f.lock.lockfileVersion = '6.0'; f.write('pnpm-lock.yaml', f.lock);
    assert.throws(f.plan, { code: 'LOCAL_LIBRARIES_LOCK_VERSION' });
    writeFileSync(join(f.root, 'pnpm-lock.yaml'), 'invalid: [secret-input');
    assert.throws(f.plan, error => error.code === 'LOCAL_LIBRARIES_YAML_INPUT' && !error.message.includes('secret-input'));
});

test('legacy fingerprints rebuild once and the next plan reuses all artifacts', t => {
    const f = fixture(t), initial = f.plan();
    const legacy = { packages: initial.records.map(row => ({ ...row, buildHash: '0'.repeat(64) })) };
    const migration = planSnapshot(f.root, catalog, { base: legacy });
    assert.deepEqual(migration.selected, all);
    assert.deepEqual(planSnapshot(f.root, catalog, { base: { packages: migration.records } }).selected, []);
});
