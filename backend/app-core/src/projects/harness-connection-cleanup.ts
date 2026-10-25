import type {EffectExecutionContext} from '@itookit/durable-kernel';
import type {HarnessConnectionAcquisition} from './harness-connections';
import {executionError, harnessExecutionJournalKey} from './harness-execution-journal';

type Owner = Pick<EffectExecutionContext, 'sessionId' | 'taskId' | 'effectId'>;

/** Failed local transport releases remain owned until retried; native facts stay in the journal. */
export class HarnessConnectionCleanup {
    private readonly pending = new Map<string, Set<() => Promise<void>>>();

    own(owner: Owner, acquired: HarnessConnectionAcquisition): HarnessConnectionAcquisition {
        const key = harnessExecutionJournalKey(owner);
        const release = async () => {
            try {
                await acquired.release();
                const entries = this.pending.get(key); entries?.delete(release);
                if (!entries?.size) this.pending.delete(key);
            } catch {
                const entries = this.pending.get(key) ?? new Set();
                entries.add(release); this.pending.set(key, entries);
                throw executionError('CLEANUP_CONNECTION_PENDING');
            }
        };
        return {...acquired, release};
    }

    async retry(owner: Owner): Promise<void> {
        const entries = [...this.pending.get(harnessExecutionJournalKey(owner)) ?? []];
        const results = await Promise.allSettled(entries.map(release => release()));
        if (results.some(result => result.status === 'rejected')) throw executionError('CLEANUP_CONNECTION_PENDING');
    }
}
