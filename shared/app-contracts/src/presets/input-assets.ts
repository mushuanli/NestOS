import type {InputAssetReference} from '@itookit/tools/contracts';

/** Application input staging; selection and Task authorization are checked separately. */
export const InputAssetCommand = {Import: 'app.assets.import', Read: 'app.assets.read', ImportFile: 'app.assets.import-file', Inspect: 'app.assets.inspect'} as const;
export const INPUT_ASSET_MAX_BYTES = 20 * 1024 * 1024;
export interface InputFileIdentity {uploadId: string; name: string; mimeType: string; bytes: number; sha256: string}
export interface InputFileUpload extends InputFileIdentity {data: ArrayBuffer}
export interface InputFileInspection {state: 'missing' | 'preparing' | 'ready'; reference?: InputAssetReference}
