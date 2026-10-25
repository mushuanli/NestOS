import {randomUUID} from '@itookit/common';

const identities = new WeakMap<File, string>();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** One selected file keeps its logical identity across encoding and restored browser objects. */
export function draftFileId(file: File): string {
    let id = identities.get(file);
    if (!id) {id = randomUUID(); identities.set(file, id);}
    return id;
}
export function restoreDraftFileId(file: File, id: string): void {
    if (!uuid.test(id) || identities.has(file) && identities.get(file) !== id)
        throw Object.assign(new Error('Invalid draft file identity'), {code: 'DRAFT_FILE_IDENTITY_INVALID'});
    identities.set(file, id);
}
export function validDraftToken(value: unknown): value is string {return typeof value === 'string' && uuid.test(value);}
