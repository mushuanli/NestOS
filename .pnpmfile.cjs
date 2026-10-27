Object.assign(process.env, require('./scripts/legacy-environment.cjs').legacyEnvironment(process.env));
const { readSelection, snapshotOverrides } = require('./scripts/local-library-state.cjs');
const path = require('node:path');
const snapshot = readSelection(__dirname);
const overrides = snapshot ? snapshotOverrides(snapshot) : {};
const peerVersions = Object.fromEntries(snapshot?.packages.map(item => [item.name, item.version]) ?? []);

// Keep graph mutations here so pnpm's hook checksum detects resolution changes.
function rewriteDependencies(pkg) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(pkg[field] || {})) if (overrides[name]) pkg[field][name] = overrides[name];
    }
    for (const name of Object.keys(pkg.peerDependencies || {})) {
        if (!peerVersions[name]) continue;
        // Peer specifications must remain semver ranges, with an explicit local dependency edge.
        pkg.peerDependencies[name] = peerVersions[name];
        const field = pkg.peerDependenciesMeta?.[name]?.optional ? 'optionalDependencies' : 'dependencies';
        (pkg[field] ??= {})[name] ??= overrides[name];
    }
    return pkg;
}

module.exports = { hooks: {
    updateConfig(config) {
        if (!snapshot) return config;
        const deployment = process.env.NESTOS_LIBRARY_DEPLOYMENT === '1';
        return { ...config, overrides: { ...config.overrides, ...overrides },
            lockfileDir: deployment ? __dirname : snapshot.lockfileDir,
            virtualStoreDir: deployment ? path.join(__dirname, 'node_modules', '.pnpm') : snapshot.virtualStoreDir,
            workspacePackagePatterns: [...(config.workspacePackagePatterns ?? ['.']), '!libraries/**'],
            linkWorkspacePackages: false, preferWorkspacePackages: false, optimisticRepeatInstall: false };
    },
    readPackage: rewriteDependencies,
} };
