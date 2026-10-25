import {sha256Hex} from '@itookit/common';
import type {ChatInputSettings, IChatInputConfig} from './ports/IChatInputPresenter';
import {draftFileId, validDraftToken} from './draft-file-identity';
import {fileBytes} from '../utils/file-bytes';
import {canonicalJson} from '../utils/canonical-json';

export interface SubmissionDraft {
    token: string; text: string; settings: ChatInputSettings;
    files: Array<{id: string; name: string; mimeType: string; bytes: number; sha256: string}>;
}
export function draftSettings(settings: ChatInputSettings): ChatInputSettings {
    const {executionModeLocked: _constraint, updatedAt: _savedAt, ...editable} = settings as ChatInputSettings & {updatedAt?: unknown};
    return structuredClone(editable);
}
export async function captureSubmissionDraft(config: IChatInputConfig, files: readonly File[]): Promise<SubmissionDraft | undefined> {
    if (!validDraftToken(config.draftToken)) return;
    const draft: SubmissionDraft = {token: config.draftToken, text: config.text, settings: draftSettings(config.settings), files: []};
    for (const file of files) {
        const data = await fileBytes(file);
        draft.files.push({id: draftFileId(file), name: file.name, mimeType: file.type, bytes: data.byteLength, sha256: await sha256Hex(data)});
    }
    return draft;
}
export function sameSubmissionDraft(left: unknown, right?: SubmissionDraft): boolean {
    return left === undefined && right === undefined || !!left && !!right && canonicalJson(left) === canonicalJson(right);
}
