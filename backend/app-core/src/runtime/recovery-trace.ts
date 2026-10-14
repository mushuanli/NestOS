/** One Session's recovery cost, as the Kernel reports it (`onSessionRecovered`). */
export interface RecoverySample {
    sessionId: string;
    state: number;
    resources: number;
}

const SLOWEST = 3;

/**
 * One line for the boot log: how many Sessions were recovered, how the time splits between
 * their Kernel state and their managed resources, and which Sessions dominated.
 *
 * Recovery is proportional to the catalog, so the count and the tail matter more than the mean.
 */
export function summarizeRecovery(samples: readonly RecoverySample[]): string {
    if (!samples.length) return 'recoverSessions: no Sessions';
    const sum = (pick: (sample: RecoverySample) => number) => samples.reduce((total, sample) => total + pick(sample), 0);
    const ranked = [...samples].sort((left, right) => cost(right) - cost(left));
    const median = cost(ranked[Math.floor(ranked.length / 2)]);
    const slowest = ranked.slice(0, SLOWEST).map(sample => `${sample.sessionId}=${cost(sample).toFixed(0)}ms`).join(' ');
    return `recoverSessions: sessions=${samples.length} state=${sum(sample => sample.state).toFixed(0)}ms`
        + ` resources=${sum(sample => sample.resources).toFixed(0)}ms median=${median.toFixed(0)}ms slowest[${slowest}]`;
}

function cost(sample: RecoverySample): number { return sample.state + sample.resources; }
