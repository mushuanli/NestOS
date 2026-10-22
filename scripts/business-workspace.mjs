import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import state from './local-library-state.mjs';
import { checkWorkspace } from './check-workspace.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const [command] = process.argv.slice(2);
if (!['build', 'build:libs', 'typecheck'].includes(command)) throw new Error(`Unsupported workspace command: ${command}`);
const snapshot = state.readSelection(root);
if (snapshot) {
    const errors = checkWorkspace(root, { installed: true, snapshot });
    if (errors.length) throw new Error(errors.join('\n'));
}
const args = command === 'build:libs'
    ? ['--filter', './ui/*', '--filter', './backend/*', '--filter', './shared/*', '--filter', './libraries/*', 'build']
    : ['-r', command];
const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
