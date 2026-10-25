import type {HarnessExecutionRequest} from '@itookit/kernel-adapters/contracts';
import {validateHarnessTurnInput, type HarnessProfile} from '@itookit/mindos-node-driver/harness';
import {executionError} from './harness-execution-journal';

/** Target preparation is pure and precedes native create/fork/turn and binding claims. */
export function validateExecutionInput(request: HarnessExecutionRequest, profile: HarnessProfile): void {
    let attachments: ReturnType<typeof validateHarnessTurnInput>;
    try {attachments = validateHarnessTurnInput(request.prompt, request.attachments);}
    catch (error) {
        const code = (error as {attachmentCode?: unknown})?.attachmentCode;
        const known = typeof code === 'string' && /^HARNESS_(ATTACHMENT|PROMPT)_[A-Z_]+$/.test(code);
        throw known ? Object.assign(executionError(code), {message: (error as Error).message}) : executionError('HARNESS_ATTACHMENT_INVALID');
    }
    if (attachments.some(file => !profile.capabilities.attachments?.includes(file.kind))) throw Object.assign(executionError('HARNESS_ATTACHMENT_KIND_UNSUPPORTED'),
        {message: 'Selected Harness does not support these attachment kinds; choose a capable Harness or remove the files'});
}
