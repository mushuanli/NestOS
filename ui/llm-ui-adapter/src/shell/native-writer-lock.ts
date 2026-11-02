import type {ConversationSnapshot} from '../contracts';
import {getLocale, t} from '@itookit/common';


/** Current host evidence is independent of the persisted submission error. */
export function nativeWriterLockText(lock: ConversationSnapshot['writerLock']): string {
    if (!lock) return t('harness.writerLock.unavailable');
    const time = (value: number | null | undefined) => value ? new Date(value).toLocaleString(getLocale(), {hour12: false}) : t('harness.writerLock.unknownTime');
    const lines = [t(`harness.writerLock.${lock.status}`), t('harness.writerLock.checkedAt', {time: time(lock.checkedAt)})];
    if (lock.owner) lines.push(`PID: ${lock.owner.pid} · UID: ${lock.owner.uid ?? t('harness.writerLock.unknownTime')}`,
        t('harness.writerLock.processStartedAt', {time: time(lock.owner.processStartedAt)}),
        t('harness.writerLock.acquiredAt', {time: time(lock.acquiredAt)}));
    if (lock.lockFileModifiedAt) lines.push(t('harness.writerLock.fileModifiedAt', {time: time(lock.lockFileModifiedAt)}));
    if (lock.code) lines.push(lock.code);
    return lines.join('\n');
}
