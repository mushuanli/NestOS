import {t} from '@itookit/common';
import type {InstructionQueueViewOptions} from '@itookit/llm-ui';

export function instructionQueueLabels(): InstructionQueueViewOptions['labels'] {
    return {
        title: t('session.instructions.title'), resume: t('session.instructions.resume'), pause: t('session.instructions.pause'),
        merge: t('session.instructions.merge'), paused: t('session.instructions.paused'), hint: t('session.instructions.hint'),
        attachments: t('session.instructions.attachments'), up: t('session.instructions.up'), down: t('session.instructions.down'),
        retry: t('session.instructions.retry'), edit: t('session.instructions.edit'), editFailed: t('session.instructions.editFailed'),
        save: t('action.save'), cancel: t('action.cancel'), remove: t('action.delete'),
        arguments: t('callable.input.arguments'), invalidArguments: t('callable.input.invalidArguments'),
        states: {pending: t('session.instructions.pending'), dispatching: t('session.instructions.dispatching'),
            failed: t('session.instructions.failed'), uncertain: t('session.instructions.uncertain')},
        reasons: {failed: t('session.instructions.reason.failed'), aborted: t('session.instructions.reason.aborted'),
            'branch-changed': t('session.instructions.reason.branch-changed'), recovery: t('session.instructions.reason.recovery')},
    };
}
