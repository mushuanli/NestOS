import {lstat, readFile, writeFile, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import {load, dump, JSON_SCHEMA} from 'js-yaml';
import {randomUUID} from '@itookit/common';
import {packageError} from './manifest';

/** Host-owned YAML never supplies executable code or arbitrary filesystem paths. */
export async function readYamlSidecar(root: string, name: 'guide' | 'toolbox'): Promise<unknown | undefined> {
    const file = path.join(root, `${name}.yaml`), code = `TOOL_PACKAGE_${name.toUpperCase()}`;
    let info;
    try {info = await lstat(file);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
    if (!info.isFile() || info.isSymbolicLink()) throw packageError(`${code}_PATH_INVALID`, 'Package documentation/configuration must be an ordinary file');
    if (info.size > 65536) throw packageError(`${code}_TOO_LARGE`, 'Package documentation/configuration exceeds 64 KiB');
    const text = await readFile(file, 'utf8');
    if (Buffer.byteLength(text) > 65536) throw packageError(`${code}_TOO_LARGE`, 'Package documentation/configuration exceeds 64 KiB');
    try {return load(text, {schema: JSON_SCHEMA});}
    catch {throw packageError(`${code}_YAML_INVALID`, 'Package documentation/configuration contains invalid YAML');}
}

/** Replace metadata atomically, including when adding it to a previously installed package. */
export async function writeYamlSidecar(root: string, name: 'guide' | 'toolbox', value: unknown): Promise<void> {
    const temporary = path.join(root, `.${name}-${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, dump(value, {noRefs: true}), {flag: 'wx', mode: 0o600});
        await rename(temporary, path.join(root, `${name}.yaml`));
    } finally {await rm(temporary, {force: true});}
}
