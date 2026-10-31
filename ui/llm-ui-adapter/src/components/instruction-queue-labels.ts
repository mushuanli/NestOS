import {t} from '@itookit/common';
import type {InstructionQueueViewOptions} from '@itookit/llm-ui';

export function instructionQueueLabels(): InstructionQueueViewOptions['labels'] {
    return {
        recovered: t('session.instructions.recovered'), recover: t('session.instructions.recover'), confirmRecovery: t('session.instructions.confirmRecovery'),
        title: t('session.instructions.title'), resume: t('session.instructions.resume'), pause: t('session.instructions.pause'),
        expand: t('session.instructions.expand'), collapse: t('session.instructions.collapse'),
        merge: t('session.instructions.merge'), paused: t('session.instructions.paused'), hint: t('session.instructions.hint'),
        attachments: t('session.instructions.attachments'), up: t('session.instructions.up'), down: t('session.instructions.down'),
        retry: t('session.instructions.retry'), edit: t('session.instructions.edit'), editFailed: t('session.instructions.editFailed'),
        save: t('action.save'), cancel: t('action.cancel'), remove: t('action.delete'),
        arguments: t('callable.input.arguments'), invalidArguments: t('callable.input.invalidArguments'),
        createdAt: t('session.instructions.createdAt'), dispatchedAt: t('session.instructions.dispatchedAt'), acceptedAt: t('session.instructions.acceptedAt'),
        states: {pending: t('session.instructions.pending'), dispatching: t('session.instructions.dispatching'),
            failed: t('session.instructions.failed'), uncertain: t('session.instructions.uncertain')},
        reasons: {failed: t('session.instructions.reason.failed'), aborted: t('session.instructions.reason.aborted'),
            paused: t('session.instructions.reason.paused'), 'active-turn': t('session.instructions.reason.activeTurn'),
            'awaiting-interaction': t('session.instructions.reason.interaction'), 'remote-offline': t('session.instructions.reason.offline'),
            'admission-unconfirmed': t('session.instructions.reason.admission'), 'terminal-unconfirmed': t('session.instructions.reason.terminal'),
            rejected: t('session.instructions.reason.rejected'),
            'branch-changed': t('session.instructions.reason.branch-changed'), recovery: t('session.instructions.reason.recovery'),
            HARNESS_SESSION_BUSY: `HARNESS_SESSION_BUSY · ${t('chat.submission.occupied')}`},
    };
}
