import {KernelError, KernelErrorCode, type Kernel} from '@itookit/durable-kernel';
import type {ISessionRepository} from '../persistence/types';
import {InstructionQueueStore} from '../persistence/instruction-queue-store';
import {hasMatchingCommittedSubmission} from '../persistence/submission-receipt';
import type {SessionInstructionInput} from '../contracts/instruction-queue';
import type {SubmissionReceipt} from '../contracts/submission';
import {instructionDigest, prepareInstruction, queueError} from './instruction-queue-rules';

/** Read existing facts without binding a view, creating a Kernel Session or waking its queue. */
export async function readSubmissionReceipt(kernel: Kernel, reader: ISessionRepository, sessionId: string, input: SessionInstructionInput): Promise<SubmissionReceipt> {
    const submission = input.sendIntent?.submission;
    if (!submission) throw queueError('SUBMISSION_INVALID', 'Submission observation requires an existing identity');
    const manifest = await reader.getManifest(sessionId), item = prepareInstruction(input, sessionId, manifest.currentBranch);
    const digest = await instructionDigest(item), queue = await readQueue(kernel, sessionId);
    const receipt = queue?.accepted?.find(entry => entry.id === item.id);
    if (receipt && receipt.digest !== digest) throw queueError('QUEUE_CONFLICT', 'Submission content differs from the accepted request');
    if (receipt) return {operationId: item.id, status: 'accepted', evidence: 'queue'};
    if (await hasMatchingCommittedSubmission(reader, sessionId, submission, digest)) return {operationId: item.id, status: 'accepted', evidence: 'history'};
    return {operationId: item.id, status: 'unknown'};
}

async function readQueue(kernel: Kernel, sessionId: string) {
    try {return await new InstructionQueueStore(kernel).read(sessionId);}
    catch (error) {
        if (!(error instanceof KernelError) || error.code !== KernelErrorCode.SESSION_NOT_FOUND) throw error;
        return undefined;
    }
}
