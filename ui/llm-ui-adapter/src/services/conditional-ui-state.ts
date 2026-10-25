import type {ConversationUIState, ISessionRepository} from '@itookit/llm-session/contracts';
export type ConditionalUIRepository = Pick<ISessionRepository, 'getManifest' | 'compareAndSetUIState'>;
export interface UIStateChange<T> {value: T; patch?: Partial<ConversationUIState>}
interface WriteOptions {
    unavailable(): Error; conflict(): Error;
    report(stage: string, attempt: number, error?: unknown): void;
}
/** Retry only rejected version conditions; unknown writes require a read-only proof of the proposal. */
export async function writeUIStateConditionally<T>(repository: ConditionalUIRepository, sessionId: string,
    prepare: (state: ConversationUIState | undefined) => UIStateChange<T>, options: WriteOptions): Promise<T> {
    let stage = 'read', attempt = 0;
    const report = (error?: unknown) => {try {options.report(stage, attempt, error);} catch { /* Diagnostics cannot alter storage facts. */ }};
    try {
        if (!repository.compareAndSetUIState) throw options.unavailable();
        for (; attempt < 8; attempt++) {
            stage = 'read'; const snapshot = await repository.getManifest(sessionId);
            if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision! < 0) throw options.unavailable();
            stage = 'prepare'; const change = prepare(snapshot.uiState);
            if (!change.patch) {stage = 'confirmed'; report(); return change.value;}
            stage = 'conditional-write';
            try {await repository.compareAndSetUIState(sessionId, snapshot.revision!, change.patch);}
            catch (error) {
                if ((error as {code?: unknown})?.code === 'SESSION_UI_STATE_CONFLICT') continue;
                stage = 'write-receipt'; const confirmed = await confirmWrite(repository, sessionId, prepare);
                if (confirmed) {report(); return confirmed.value;}
                throw error;
            }
            report(); return change.value;
        }
        throw options.conflict();
    } catch (error) {report(error); throw error;}
}
async function confirmWrite<T>(repository: ConditionalUIRepository, sessionId: string,
    prepare: (state: ConversationUIState | undefined) => UIStateChange<T>): Promise<UIStateChange<T> | undefined> {
    try {const change = prepare((await repository.getManifest(sessionId)).uiState); return change.patch ? undefined : change;}
    catch {return;}
}
