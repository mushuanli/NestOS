import {randomUUID, sha256HexSync} from '@itookit/common';
import type {IFileSystem} from '@itookit/vfs-core';

export interface PromptFile {name: string; content: string; sha256: string; source: string}
export interface PromptBundle {version: 1; files: PromptFile[]}
export interface PromptJournal {get<T>(key: string): Promise<T | undefined>; update<T>(key: string, change: (old: T | undefined) => T): Promise<T>}

export async function readPrompt(fs: IFileSystem, path: string): Promise<string> {
    const node = await fs.driver.getNode(path);
    if (node?.type !== 'file' || node.size < 1 || node.size > 65536) throw failure('PROMPT_FILE_INVALID');
    const bytes = await fs.driver.readContent(path, {encoding: 'binary', length: node.size});
    const after = await fs.driver.getNode(path);
    if (bytes.byteLength !== node.size || after?.type !== 'file' || after.revision !== node.revision || after.size !== node.size || after.modifiedAt !== node.modifiedAt)
        throw failure('PROMPT_READ_CONFLICT');
    try {return new TextDecoder('utf-8', {fatal: true}).decode(bytes);}
    catch {throw failure('PROMPT_ENCODING_INVALID');}
}

/** Freeze before transmission; a restart never resolves current authoring files again. */
export async function freezePrompts(journal: PromptJournal, key: string, resolve: () => Promise<PromptFile[]>): Promise<PromptBundle> {
    const saved = await journal.get<PromptBundle>(key); if (saved) return saved;
    const files = await resolve();
    if (files.length > 16 || new Set(files.map(file => file.name)).size !== files.length) throw failure('PROMPT_BUNDLE_INVALID');
    for (const file of files) {
        if (!/^[a-zA-Z0-9_-]+\.md$/.test(file.name) || file.sha256 !== sha256HexSync(file.content)
            || new TextEncoder().encode(file.content).byteLength > 65536) throw failure('PROMPT_BUNDLE_INVALID');
    }
    return journal.update<PromptBundle>(key, old => old ?? {version: 1, files});
}

/** The manifest is the publication boundary; every existing byte must match the snapshot. */
export async function publishPromptBundle(fs: IFileSystem, directory: string, bundle: PromptBundle, context: unknown): Promise<string> {
    for (const file of bundle.files) await publishFile(fs, directory + '/prompts', file.name, file.content);
    const manifest = bundleManifest(bundle, context);
    await publishFile(fs, directory, 'manifest.json', manifest);
    return sha256HexSync(manifest);
}

async function publishFile(fs: IFileSystem, directory: string, name: string, content: string): Promise<void> {
    const path = directory + '/' + name;
    if (await fs.driver.exists(path)) {
        if (await readPrompt(fs, path) !== content) throw failure('PROMPT_SNAPSHOT_CHANGED');
        return;
    }
    const temporary = '.upload-' + randomUUID();
    await fs.driver.createFile({parentPath: directory, name: temporary, content, recursive: true});
    if (await readPrompt(fs, directory + '/' + temporary) !== content) throw failure('PROMPT_UPLOAD_MISMATCH');
    try {await fs.driver.rename(directory + '/' + temporary, name);}
    catch (error) {
        if ((error as {code?: string}).code !== 'EEXIST' || await readPrompt(fs, path) !== content) throw error;
    }
}
export function failure(code: string): Error & {code: string} {return Object.assign(new Error(code), {code});}

function bundleManifest(bundle: PromptBundle, context: unknown): string {
    const files = bundle.files.map(({content: _content, ...file}) => ({...file, path: 'prompts/' + file.name}));
    return JSON.stringify({version: 1, files, context});
}
export async function verifyPromptBundle(fs: IFileSystem, directory: string, bundle: PromptBundle, context: unknown): Promise<void> {
    for (const file of bundle.files) {
        if (await readPrompt(fs, directory + '/prompts/' + file.name) !== file.content) throw failure('PROMPT_SNAPSHOT_CHANGED');
    }
    if (await readPrompt(fs, directory + '/manifest.json') !== bundleManifest(bundle, context)) throw failure('PROMPT_MANIFEST_CHANGED');
}

/** Recognize section headings without treating fenced examples as lifecycle declarations. */
export function hasMarkdownSection(content: string, section: string): boolean {
    let fence: {character: string; length: number} | undefined;
    for (const line of content.split(/\r?\n/)) {
        const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (match) {
            if (!fence) fence = {character: match[1][0], length: match[1].length};
            else if (match[1][0] === fence.character && match[1].length >= fence.length && !line.slice(match[0].length).trim()) fence = undefined;
            continue;
        }
        if (!fence && line.trim() === '## ' + section) return true;
    }
    return false;
}
