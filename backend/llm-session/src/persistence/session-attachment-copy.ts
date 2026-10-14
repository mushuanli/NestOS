import { FSError, type IFileSystem } from '@itookit/vfs-core';

/** Resume interrupted copies without replacing a differing target or deleting originals. */
export async function copySessionAttachments(fs: IFileSystem, from: string, to: string): Promise<void> {
    const source = await fs.driver.getNode(from), target = await fs.driver.getNode(to);
    if (!source) {
        if (target) throw new FSError('ECONFLICT', 'Unexpected relocation attachment target');
        return;
    }
    if (source.type !== 'directory' || (target && target.type !== 'directory'))
        throw new FSError('ECONFLICT', 'Invalid relocation attachment directory');
    if (!target) await fs.driver.createDirectory({ parentPath: to.slice(0, to.lastIndexOf('/')), name: to.split('/').pop()! });
    const children = await fs.driver.getChildren(from, { includeHidden: true, includeInternalDirs: true });
    const names = new Set(children.map(child => child.name));
    for (const child of await fs.driver.getChildren(to, { includeHidden: true, includeInternalDirs: true }))
        if (!names.has(child.name)) throw new FSError('ECONFLICT', 'Unexpected relocation attachment; original retained');
    for (const child of children) {
        const destination = `${to}/${child.name}`;
        if (child.type === 'directory') await copySessionAttachments(fs, child.path, destination);
        else if (child.type === 'file') await copyAttachment(fs, child.path, destination);
        else throw new FSError('ECAPABILITY', 'Unsupported relocation attachment type');
    }
}

async function copyAttachment(fs: IFileSystem, from: string, to: string): Promise<void> {
    const bytes = await fs.driver.readContent(from, { encoding: 'binary' });
    if (!await fs.driver.exists(to)) await fs.driver.createFile({ parentPath: to.slice(0, to.lastIndexOf('/')),
        name: to.split('/').pop()!, content: bytes });
    const copied = new Uint8Array(await fs.driver.readContent(to, { encoding: 'binary' }));
    const current = new Uint8Array(await fs.driver.readContent(from, { encoding: 'binary' }));
    const expected = new Uint8Array(bytes);
    if (!equal(expected, copied) || !equal(expected, current))
        throw new FSError('ECONFLICT', 'Relocation attachment differs; original retained');
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}
