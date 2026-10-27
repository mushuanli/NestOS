// scripts/deploy-gh-pages.js
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.resolve(rootDir, 'apps/web-app/dist');
const worktreeDir = path.resolve(rootDir, `.gh-pages-deploy-${crypto.randomBytes(4).toString('hex')}`);

if (!fs.existsSync(distDir)) {
    console.error('❌ dist not found at:', distDir);
    console.error('👉 Run: pnpm --filter ./apps/web-app build');
    process.exit(1);
}

function cleanup() {
    try {
        execSync(`git worktree remove --force "${worktreeDir}"`, { cwd: rootDir, stdio: 'pipe' });
    } catch { /* ok */ }
    try {
        if (fs.existsSync(worktreeDir)) fs.rmSync(worktreeDir, { recursive: true, force: true });
    } catch { /* ok */ }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

try {
    // Clean up stale worktree from previous failed runs
    cleanup();

    execSync('git fetch origin gh-pages', { cwd: rootDir, stdio: 'inherit' });

    // Ensure gh-pages branch exists locally
    try {
        execSync('git rev-parse --verify gh-pages', { cwd: rootDir, stdio: 'pipe' });
    } catch {
        console.log('📥 Fetching gh-pages branch from origin...');
        execSync('git fetch origin gh-pages:gh-pages', { cwd: rootDir, stdio: 'inherit' });
    }

    // Create worktree from gh-pages
    console.log('🌲 Creating worktree...');
    execSync(`git worktree add -B gh-pages "${worktreeDir}" origin/gh-pages`, { cwd: rootDir, stdio: 'inherit' });

    // Clear all files except .git
    for (const file of fs.readdirSync(worktreeDir)) {
        if (file !== '.git') {
            fs.rmSync(path.join(worktreeDir, file), { recursive: true, force: true });
        }
    }

    // Copy build output
    console.log('📂 Copying build output...');
    fs.cpSync(distDir, worktreeDir, { recursive: true });
    const commit = execSync('git rev-parse HEAD', { cwd: rootDir, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(worktreeDir, 'build.json'), JSON.stringify({ commit, deployedAt: new Date().toISOString() }) + '\n');
    fs.writeFileSync(path.join(worktreeDir, '.nojekyll'), '');

    // Commit if there are changes
    execSync('git add -A', { cwd: worktreeDir, stdio: 'inherit' });
    const status = execSync('git status --porcelain', { cwd: worktreeDir, encoding: 'utf8' });

    if (status.trim()) {
        const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 16);
        const msg = `deploy(pages): publish ${commit.slice(0, 8)} — ${dateStr}`;
        execSync(`git commit -m "${msg}"`, { cwd: worktreeDir, stdio: 'inherit' });
        execSync('git push origin gh-pages', { cwd: worktreeDir, stdio: 'inherit' });
        console.log('✅ Deployed to gh-pages');
    } else {
        console.log('⏭  No changes to deploy');
    }
} finally {
    cleanup();
    console.log('🧹 Cleaned up worktree');
}
