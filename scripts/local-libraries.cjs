const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

/** Local standalone libraries use their package exports; missing checkouts stay on npm. */
function localLibraryOverrides(root, libraries) {
    const overrides = {};
    for (const library of libraries) {
        if (library.workspace) continue;
        const manifest = join(root, 'packages', library.directory, 'package.json');
        if (!existsSync(manifest)) continue;
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        if (pkg.name !== library.name) throw new Error(`Local library name mismatch: ${manifest}`);
        const sourceEntry = [pkg.main, pkg.module].some(entry => entry?.startsWith('./src/'))
            || JSON.stringify(pkg.exports ?? {}).includes('"./src/');
        overrides[library.name] = `${sourceEntry ? 'link' : 'file'}:./packages/${library.directory}`;
    }
    return overrides;
}

/** Locate consumer manifests so generated file ranges remain portable in the lockfile. */
function localPackageDirectories(root) {
    const directories = new Map();
    const add = directory => {
        const manifest = join(directory, 'package.json');
        if (existsSync(manifest)) directories.set(JSON.parse(readFileSync(manifest, 'utf8')).name, directory);
    };
    add(root);
    for (const group of ['packages', 'apps']) {
        const parent = join(root, group);
        if (!existsSync(parent)) continue;
        for (const entry of readdirSync(parent, { withFileTypes: true })) if (entry.isDirectory()) add(join(parent, entry.name));
    }
    return directories;
}

module.exports = { localLibraryOverrides, localPackageDirectories };
