import type {ConversationSnapshot} from '../contracts';
import {ExecutionNotice} from '@itookit/llm-ui';
import {t} from '@itookit/common';


/** Native policy supplies the message; the shared library owns DOM and clock lifecycle. */
export class NativeExecutionNotice {
    private readonly view = new ExecutionNotice(seconds => t('harness.compactingElapsed', {seconds}));
    private snapshot?: ConversationSnapshot;
    private active = true;
    readonly element = this.view.element;
    update(snapshot?: ConversationSnapshot): void {
        this.snapshot = snapshot;
        const observation = snapshot?.observation, activity = observation?.activity;
        this.view.update(observation?.execution === 'running' && activity?.phase === 'compacting'
            ? {message: t('harness.compactingNotice'), updatedAt: activity.updatedAt} : undefined, this.active);
    }
    setActive(value: boolean): void {this.active = value; this.update(this.snapshot);}
    destroy(): void {this.view.destroy(); this.snapshot = undefined;}
}
