import {sha256HexSync} from '@itookit/llm-context';
import type {TwinSourceReader} from './domain';
import type {TwinRecords} from './records';
const prefix = 'scanner-input://';
const key = (id: string) => 'scanner-input:' + id;

export async function saveScannerText(records: TwinRecords, text: string): Promise<string> {
    if (typeof text !== 'string' || !text.trim() || new TextEncoder().encode(text).byteLength > 128 * 1024 || text.includes('\0')) throw new Error('TWIN_SCANNER_TEXT_INVALID');
    const id = sha256HexSync(text), previous = await records.get<{text: string}>('checkpoint', key(id));
    if (previous && previous.data.text !== text) throw new Error('TWIN_SCANNER_INPUT_CONFLICT');
    if (!previous) await records.save('checkpoint', key(id), {text}, null);
    return prefix + id;
}

/** Input snapshots are scoped by the already-authorized Twin store, never by caller-supplied paths. */
export function scannerInputReader(records: TwinRecords, reader: TwinSourceReader): TwinSourceReader {
    const read: TwinSourceReader['read'] = async spec => {
        if (!spec.target.startsWith(prefix)) return reader.read(spec);
        const id = spec.target.slice(prefix.length);
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('TWIN_SCANNER_INPUT_INVALID');
        const entry = await records.get<{text: string}>('checkpoint', key(id));
        if (!entry || sha256HexSync(entry.data.text) !== id) throw new Error('TWIN_SCANNER_INPUT_MISSING');
        return {text: entry.data.text, hash: id, nativeIdentity: spec.target};
    };
    return {read, sessions: () => reader.sessions(), ...(reader.discover ? {discover: () => reader.discover!()} : {}),
        probe: spec => spec.target.startsWith(prefix) ? read(spec).then(result => result.hash) : reader.probe?.(spec) ?? Promise.resolve('')};
}
