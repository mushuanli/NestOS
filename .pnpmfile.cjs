const libraries = require('./scripts/npm-libraries.json');
const { localLibraryOverrides, localPackageDirectories } = require('./scripts/local-libraries.cjs');
const { resolve, relative } = require('node:path');
const directories = localPackageDirectories(__dirname);
const local = localLibraryOverrides(__dirname, libraries);

module.exports = {
    hooks: {
        updateConfig(config) {
            return { ...config, overrides: { ...config.overrides, ...local } };
        },
        readPackage(pkg) {
            for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
                for (const name of Object.keys(pkg[section] || {})) {
                    if (!local[name]) continue;
                    const target = resolve(__dirname, local[name].slice(5));
                    const directory = directories.get(pkg.name);
                    pkg[section][name] = local[name].slice(0, 5) + (directory ? relative(directory, target).replaceAll('\\', '/') : target);
                }
            }
            return pkg;
        },
    },
};
