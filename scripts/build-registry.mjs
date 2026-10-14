import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { libraries, root } from './npm-libraries.mjs';
import { prepareRegistryWorkspace } from './registry-workspace.mjs';

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
}

function verifyVersions() {
    for (const library of libraries) {
        const spec = `${library.name}@${library.version}`;
        const result = spawnSync('npm', ['view', spec, 'version', '--json'], { cwd: root, encoding: 'utf8' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`Registry version unavailable: ${spec}. Publish or update the release catalog before building; workspace sources are not substituted.`);
    }
}

try {
    const prepareOnly = process.argv.includes('--prepare-only'), updateLock = process.argv.includes('--update-lock');
    if (!prepareOnly) verifyVersions();
    const parent = join(root, 'release'); mkdirSync(parent, { recursive: true });
    const directory = prepareRegistryWorkspace(root, mkdtempSync(join(parent, 'registry-')));
    console.log(`Registry workspace: ${directory}`);
    if (!prepareOnly) {
        const frozen = existsSync(join(directory, 'pnpm-lock.yaml')) && !updateLock;
        run('pnpm', ['install', frozen ? '--frozen-lockfile' : '--no-frozen-lockfile'], directory);
        const args = process.argv.slice(2).filter(arg => !['--', '--update-lock'].includes(arg));
        run('pnpm', args.length ? args : ['--filter', 'mind-os', 'build'], directory);
        cpSync(join(directory, 'pnpm-lock.yaml'), join(root, 'pnpm-lock.registry.yaml'));
        console.log(`Registry build complete: ${directory}`);
    }
} catch (error) { console.error(error.message); process.exitCode = 1; }
