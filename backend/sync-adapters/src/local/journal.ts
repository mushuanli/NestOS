import { link, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertBinding, assertSync, applyBaseline, sha256, type FileAction, type SyncState } from '@itookit/vfs-sync';
import type { ISidecarDb, LocalStorageAccess } from '@itookit/vfsdriver-local';
import { createDurable, ensureDirectory, nativePath, stat, syncDirectory } from './files';
import { inspectNode, scanLocal, type LocalNode, type LocalSnapshot } from './scan';
export interface JournalItem { action: FileAction; expected?: LocalNode; stage?: string; backup: string; installed?: { dev: string; ino: string }; done?: boolean }
export interface ApplyJournal { version: 1; id: string; token: string; root: string; rootDev: string; rootIno: string; items: JournalItem[] }
export interface JournalHost {
    storage: LocalStorageAccess; controlPath: string;
    transaction<T>(action: (db: ISidecarDb) => Promise<T>): Promise<T>;
    load(db: ISidecarDb): Promise<SyncState>;
    save(db: ISidecarDb, state: SyncState): Promise<void>;
    object(hash: string): Promise<Uint8Array>;
}
export async function prepareJournal(host: JournalHost, token: string, capture: LocalSnapshot, actions: FileAction[], id: string): Promise<void> {
    const objects = new Map<string, Uint8Array>();
    for (const action of actions) if (action.output?.kind === 'file') objects.set(action.output.hash, await host.object(action.output.hash));
    await host.transaction(async db => {
        const state = await host.load(db); assertBinding(token, state.binding); assertSync(state.binding.state === 'active', 'BINDING_INACTIVE');
        if (await db.getRecordField(host.controlPath, 'apply:' + id)) return;
        const pending = await db.getRecordField(host.controlPath, 'applyPending');
        if (pending) { const journal = JSON.parse(pending as string) as ApplyJournal; assertSync(journal.id === id && journal.token === token, 'LOCAL_APPLY_PENDING'); return; }
        await validateCapture(host, db, state.binding.root, capture, actions);
        const root = await stat(await nativePath(host.storage, state.binding.root)); assertSync(root && root.isDirectory(), 'SYNC_ROOT_UNAVAILABLE');
        const journal: ApplyJournal = { version: 1, id, token, root: state.binding.root, rootDev: String(root.dev), rootIno: String(root.ino), items: [] };
        for (const [index, action] of ordered(actions).entries()) journal.items.push(await stageItem(host, id, index, action, capture.nodes[action.path], objects));
        await db.setRecordField(host.controlPath, 'applyPending', JSON.stringify(journal));
    });
}
async function stageItem(host: JournalHost, id: string, index: number, action: FileAction, expected: LocalNode | undefined, objects: Map<string, Uint8Array>): Promise<JournalItem> {
    const prefix = host.controlPath.slice(0, -10) + '/journal/' + id + '/' + index;
    const backup = prefix + '-before', item: JournalItem = { action, expected, backup };
    await ensureDirectory(dirname(await nativePath(host.storage, backup)));
    if (action.output?.kind === 'file') {
        item.stage = prefix + '-after'; const path = await nativePath(host.storage, item.stage);
        // An interrupted preparation never authorizes reusing arbitrary staging data.
        const existing = await stat(path);
        if (!existing) await createDurable(path, objects.get(action.output.hash)!, action.output.executable ? 0o755 : 0o644);
        else assertSync(existing.isFile() && await sha256(await readFile(path)) === action.output.hash
            && !!(existing.mode & 0o111) === !!action.output.executable, 'LOCAL_PREPARATION_PENDING');
        const node = (await stat(path))!; item.installed = { dev: String(node.dev), ino: String(node.ino) };
    }
    return item;
}
function ordered(actions: FileAction[]): FileAction[] {
    const depth = (action: FileAction) => action.path.split('/').length;
    return [...actions.filter(a => !a.output).sort((a, b) => depth(b) - depth(a)),
        ...actions.filter(a => a.output).sort((a, b) => depth(a) - depth(b))];
}
async function validateCapture(host: JournalHost, db: ISidecarDb, root: string, capture: LocalSnapshot, actions: FileAction[]): Promise<void> {
    assertSync(capture?.nodes && capture.scan, 'INVALID_LOCAL_SNAPSHOT');
    const current = await scanLocal(host.storage, db, root);
    assertSync(capture.root && current.root.dev === capture.root.dev && current.root.ino === capture.root.ino, 'SYNC_ROOT_CHANGED');
    for (const action of actions) {
        const path = action.path, expected = capture.nodes[path], actual = current.nodes[path];
        assertSync(!current.scan.entries[path] || current.scan.entries[path].state === 'present', 'LOCAL_CHANGED');
        assertSync(sameInput(expected, actual), 'LOCAL_CHANGED');
        if (expected?.kind === 'directory' && action.output?.kind !== 'directory') {
            assertSync(current.scan.completeDirectories.includes(path) && Object.keys(current.scan.entries)
                .filter(p => p.startsWith(path + '/')).every(p => actions.some(a => a.path === p && !a.output)), 'DIRECTORY_GROUP_BLOCKED');
        }
    }
}
function sameInput(expected?: LocalNode, actual?: LocalNode): boolean {
    if (!expected || !actual) return !expected && !actual;
    return expected.kind === actual.kind && expected.dev === actual.dev && expected.ino === actual.ino
        && expected.metadata === actual.metadata && (expected.kind === 'directory' ||
            (expected.mtime === actual.mtime && expected.hash === actual.hash && expected.mode === actual.mode));
}
export async function finishJournal(host: JournalHost, token: string, id: string): Promise<void> {
    let remaining = true;
    while (remaining) remaining = await host.transaction(async db => {
        const state = await host.load(db); assertBinding(token, state.binding); assertSync(state.binding.state === 'active', 'BINDING_INACTIVE');
        if (await db.getRecordField(host.controlPath, 'apply:' + id)) return false;
        const raw = await db.getRecordField(host.controlPath, 'applyPending'); assertSync(typeof raw === 'string', 'LOCAL_JOURNAL_MISSING');
        const journal = JSON.parse(raw) as ApplyJournal;
        assertSync(journal.version === 1 && journal.id === id && journal.token === token && journal.root === state.binding.root, 'LOCAL_JOURNAL_CHANGED');
        const root = await stat(await nativePath(host.storage, journal.root));
        assertSync(root?.isDirectory() && String(root.dev) === journal.rootDev && String(root.ino) === journal.rootIno, 'SYNC_ROOT_CHANGED');
        const item = journal.items.find(item => !item.done);
        if (!item) { await db.setRecordField(host.controlPath, 'apply:' + id, token); await db.deleteRecordField(host.controlPath, 'applyPending'); return false; }
        await applyItem(host, db, journal.root, item);
        item.done = true; state.baseline = applyBaseline(state.baseline, [item.action]);
        if (!item.action.output) await db.deleteMetaExt(journal.root + '/' + item.action.path);
        await host.save(db, state); await db.setRecordField(host.controlPath, 'applyPending', JSON.stringify(journal)); return true;
    });
}
async function applyItem(host: JournalHost, db: ISidecarDb, root: string, item: JournalItem): Promise<void> {
    const virtual = root + '/' + item.action.path, target = await nativePath(host.storage, virtual), current = await stat(target);
    if (item.installed && current && String(current.dev) === item.installed.dev && String(current.ino) === item.installed.ino) return;
    if (item.expected?.kind === 'directory' && item.action.output?.kind === 'directory') {
        const actual = await inspectNode(target, db, virtual); assertSync(sameInput(item.expected, actual?.node), 'LOCAL_CHANGED'); return;
    }
    const backup = await nativePath(host.storage, item.backup);
    if (item.expected) await preserveOriginal(db, virtual, target, backup, item.expected);
    else assertSync(!current, 'LOCAL_APPLY_AMBIGUOUS');
    if (!item.action.output) { assertSync(!await stat(target), 'LOCAL_APPLY_AMBIGUOUS'); return; }
    if (item.action.output.kind === 'directory') await mkdir(target);
    else {
        const stage = await nativePath(host.storage, item.stage!);
        assertSync((await stat(dirname(target)))?.dev === (await stat(stage))?.dev, 'LOCAL_SYNC_CROSS_DEVICE');
        await link(stage, target);
    }
    await syncDirectory(dirname(target));
}
async function preserveOriginal(db: ISidecarDb, virtual: string, target: string, backup: string, expected: LocalNode): Promise<void> {
    if (!await stat(backup)) {
        const actual = await inspectNode(target, db, virtual); assertSync(sameInput(expected, actual?.node), 'LOCAL_CHANGED');
        await rename(target, backup); await syncDirectory(dirname(target)); await syncDirectory(dirname(backup));
    }
    const saved = await inspectNode(backup, db, virtual); assertSync(sameInput(expected, saved?.node), 'LOCAL_APPLY_AMBIGUOUS');
    if (expected.kind === 'directory') assertSync((await readdir(backup)).length === 0, 'DIRECTORY_GROUP_BLOCKED');
    assertSync(!await stat(target), 'LOCAL_APPLY_AMBIGUOUS');
}
