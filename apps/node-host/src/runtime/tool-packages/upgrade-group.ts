import type {RegisteredToolPackage} from './store';
export interface PreparedActivation {needsSync?: boolean; check(): void; commit(): void; rollback(): void | Promise<void>; block(): void; resume(): void}
export interface UpgradeParticipant {preparePackage(record: RegisteredToolPackage): Promise<PreparedActivation>}
const groups = new Map<string, Set<UpgradeParticipant>>();
/** The registry lock is also the admission barrier for newly opened user runtimes. */
export function joinUpgradeGroup(file: string, participant: UpgradeParticipant): () => void {
    const group = groups.get(file) ?? new Set(); group.add(participant); groups.set(file, group);
    return () => {group.delete(participant); if (!group.size) groups.delete(file);};
}
export async function prepareUpgradeGroup(file: string, record: RegisteredToolPackage): Promise<PreparedActivation[]> {
    const prepared: PreparedActivation[] = [];
    try {for (const participant of groups.get(file) ?? []) prepared.push(await participant.preparePackage(record)); return prepared;}
    catch (error) {await rollbackActivations(prepared); throw error;}
}

/** Always attempt every rollback, even when one participant cannot restore its state. */
export async function rollbackActivations(prepared: PreparedActivation[]): Promise<boolean> {
    let restored = true;
    for (const activation of [...prepared].reverse()) {
        try {await activation.rollback();} catch {restored = false;}
    }
    return restored;
}
