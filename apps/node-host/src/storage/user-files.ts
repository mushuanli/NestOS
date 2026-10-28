import path from 'node:path';
import {promises as fs} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {FSError} from '@itookit/vfs-core';
import type {IFsOps, StatResult} from '@itookit/vfsdriver-local';
import {within} from '../runtime/paths';

/** Keep logical record keys unchanged while user documents live directly in the portable home. */
export class UserFiles implements IFsOps {
    constructor(private readonly state: string, private readonly home: string) {}
    private async resolve(value: string): Promise<string> {
        const prefix = path.join(this.state, 'home', 'admin');
        const document = within(prefix, value);
        const result = document ? path.join(this.home, path.relative(prefix, value)) : value;
        if (document && within(path.join(this.home, '.nestos'), result)) throw new FSError('EACCES', 'User internals are private');
        if (!within(this.home, result)) throw new FSError('EACCES', 'User storage path escaped its bundle');
        let current = this.home;
        for (const part of path.relative(this.home, result).split(path.sep).filter(Boolean)) {
            current = path.join(current, part);
            try {if ((await fs.lstat(current)).isSymbolicLink()) throw new FSError('EACCES', 'User storage links are unavailable');}
            catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error;}
        }
        return result;
    }
    async readFile(value: string): Promise<ArrayBuffer | null> {
        try {const data = await fs.readFile(await this.resolve(value)); return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;}
        catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;}
    }
    async readFileRange(value: string, offset: number, length: number): Promise<ArrayBuffer | null> {
        let handle;
        try {handle = await fs.open(await this.resolve(value), 'r');}
        catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;}
        try {const data = Buffer.alloc(length), read = await handle.read(data, 0, length, offset); return data.buffer.slice(data.byteOffset, data.byteOffset + read.bytesRead) as ArrayBuffer;}
        finally {await handle.close();}
    }
    async writeFile(value: string, data: ArrayBuffer): Promise<void> {
        const target = await this.resolve(value); await fs.mkdir(path.dirname(target), {recursive: true, mode: 0o700});
        const temporary = target + '.' + randomUUID() + '.tmp', handle = await fs.open(temporary, 'wx', 0o600);
        try {try {await handle.writeFile(Buffer.from(data));} finally {await handle.close();} await fs.rename(temporary, target);}
        finally {await fs.unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});}
    }
    async appendFile(value: string, data: ArrayBuffer): Promise<void> {await fs.appendFile(await this.resolve(value), Buffer.from(data), {mode: 0o600});}
    async stat(value: string): Promise<StatResult | null> {
        try {const info = await fs.lstat(await this.resolve(value)); return {size: info.size, mtimeMs: info.mtimeMs, birthtimeMs: info.birthtimeMs,
            isDirectory: info.isDirectory(), isFile: info.isFile(), isSymbolicLink: info.isSymbolicLink()};}
        catch (error) {if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error;}
    }
    statMany(values: string[]): Promise<Array<StatResult | null>> {return Promise.all(values.map(value => this.stat(value)));}
    async readDir(value: string) {
        const target = await this.resolve(value);
        try {return (await fs.readdir(target, {withFileTypes: true})).filter(entry => target !== this.home || entry.name !== '.nestos')
            .map(entry => ({name: entry.name, isDirectory: entry.isDirectory()}));}
        catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error;}
    }
    async mkdir(value: string): Promise<void> {await fs.mkdir(await this.resolve(value), {recursive: true, mode: 0o700});}
    async rename(from: string, to: string): Promise<void> {
        const source = await this.resolve(from), target = await this.resolve(to);
        if (source === this.home || source === this.state || target === this.home || target === this.state) throw new FSError('EACCES', 'Cannot move storage roots');
        await fs.rename(source, target);
    }
    async unlink(value: string): Promise<void> {await fs.unlink(await this.resolve(value)).catch(error => {if (error.code !== 'ENOENT') throw error;});}
    async rmdir(value: string): Promise<void> {
        const target = await this.resolve(value);
        if (target === this.home || target === this.state) throw new FSError('EACCES', 'Cannot remove storage roots');
        await fs.rmdir(target).catch(error => {if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;});
    }
    async exists(value: string): Promise<boolean> {return Boolean(await this.stat(value));}
}
