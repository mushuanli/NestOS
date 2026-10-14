import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { libraries, root } from './npm-libraries.mjs';
import { sourceExports, workspacePackages } from './workspace-packages.mjs';

function sourceErrors(repository, catalog) {
    return catalog.flatMap(library => {
        const directory = resolve(repository, 'libraries', library.directory), file = resolve(directory, 'package.json');
        if (!existsSync(file)) return [`Missing source: libraries/${library.directory}; run git submodule update --init --recursive -- libraries`];
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        if (manifest.name !== library.name) return [`Library name mismatch: ${file}`];
        const entries = sourceExports(manifest);
        if (!entries.some(([name]) => name === library.name)) return [`Missing public source entry: ${library.name}`];
        return entries.flatMap(([name, entry]) =>
            entry.startsWith('./src/') && existsSync(resolve(directory, entry)) ? [] : [`Missing source export: ${name} → ${entry}`]);
    });
}

function dependencyErrors(pkg, packages, installed) {
    const require = createRequire(resolve(pkg.directory, 'package.json'));
    return Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }).flatMap(([name, spec]) => {
        const target = packages.find(candidate => candidate.name === name);
        if (!name.startsWith('@itookit/')) return [];
        if (!target) return [`${pkg.name}: missing workspace dependency ${name}`];
        if (pkg.group !== 'libraries' && spec !== 'workspace:*') return [`${pkg.name}: ${name} must use workspace:*`];
        if (!installed) return [];
        try {
            const actual = realpathSync(require.resolve(name)), expected = sourceExports(target).find(([key]) => key === name)?.[1];
            return expected && actual === realpathSync(resolve(target.directory, expected)) ? [] : [`${pkg.name}: ${name} resolves outside its workspace source`];
        } catch (error) { return [`${pkg.name}: cannot resolve ${name} (${error.code})`]; }
    });
}

export function checkWorkspace(repository, { catalog = libraries, installed = false } = {}) {
    const packages = workspacePackages(repository);
    const file = resolve(repository, 'package.json');
    if (existsSync(file)) packages.push({ ...JSON.parse(readFileSync(file, 'utf8')), directory: repository, group: 'root' });
    const duplicates = packages.filter((pkg, index) => packages.findIndex(other => other.name === pkg.name) !== index);
    return [...sourceErrors(repository, catalog), ...duplicates.map(pkg => `Duplicate workspace package: ${pkg.name}`),
        ...packages.flatMap(pkg => dependencyErrors(pkg, packages, installed))];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const errors = checkWorkspace(root, { installed: process.argv.includes('--installed') });
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
    else console.log(`Workspace source check passed${process.argv.includes('--installed') ? ' (installed dependency links)' : ''}`);
}
