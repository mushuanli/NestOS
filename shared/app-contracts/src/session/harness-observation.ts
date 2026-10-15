import type { HarnessSession, HarnessObservation } from '@itookit/piagent-driver/harness';

export function harnessObservation(session: HarnessSession | undefined, requests: Array<{kind: string}> = [],
    evidence: Partial<HarnessObservation> = {}): HarnessObservation {
    const flags = session?.statusDetails?.activeFlags ?? [];
    const waitingApproval = requests.some(r => r.kind === 'approval') || flags.includes('waitingOnApproval');
    const waitingInput = requests.some(r => r.kind === 'input') || flags.includes('waitingOnUserInput');
    const execution = waitingApproval ? 'waiting-approval' : waitingInput ? 'waiting-input'
        : session?.activeTurnId || session?.status === 'active' ? 'running' : session?.status === 'idle' ? 'idle' : 'unknown';
    return {execution, updatedAt: session?.updatedAt, rawStatus: session?.status ?? null, nativeError: session?.status === 'systemError', lastResult: session?.lastTurnResult,
        activeTurnId: session?.activeTurnId, owned: !!session?.owned, observedAt: Date.now(), source: 'history',
        connection: 'online', stale: false, receiptUnknown: false, canInterrupt: false, canRespond: false, ...evidence};
}
