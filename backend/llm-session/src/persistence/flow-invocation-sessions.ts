// @file: llm-session/src/persistence/flow-invocation-sessions.ts
// 记录"曾经受理过 Flow 调用"的 Session，供启动恢复跳过其余会话。
import type { IFileSystem } from '@itookit/vfs-core';

/**
 * Sessions that ever admitted a Flow invocation.
 *
 * `mark` runs **before** an invocation's durable record is written, so a marker failure can only
 * cause an extra scan on the next boot, never a missed resume. A missing, corrupt or unreadable
 * marker reports "unknown" (`undefined`) and the caller falls back to probing every Session —
 * which also heals data roots written before the marker existed.
 */
export interface FlowInvocationSessions {
    /** Marked Sessions, or undefined when the marker is unavailable and every Session must be probed. */
    sessions(): Promise<Set<string> | undefined>;
    /** Persist a Session before its first invocation record; repeated calls are cheap. */
    mark(sessionId: string): Promise<void>;
    /**
     * Replace the marker with the exact set a **complete** probe found (possibly empty).
     *
     * A data root that predates the marker reports unknown on its first boot; sealing the probe
     * result keeps every later boot on the cheap path instead of re-probing forever.
     */
    establish(sessionIds: Iterable<string>): Promise<void>;
}

const MARKER_PATH = '/var/lib/kernel/flow-invocations.json';
const MARKER_VERSION = 1;

export function createFlowInvocationSessions(fs: IFileSystem): FlowInvocationSessions {
    let known: Set<string> | undefined;
    let tail: Promise<unknown> = Promise.resolve();
    const load = async (): Promise<Set<string> | undefined> => {
        if (known) return known;
        try {
            if (!await fs.driver.exists(MARKER_PATH)) return undefined;
            const parsed = JSON.parse(await fs.driver.readContent(MARKER_PATH, { encoding: 'utf-8' })) as { version?: unknown; sessions?: unknown };
            if (parsed.version !== MARKER_VERSION || !Array.isArray(parsed.sessions)) return undefined;
            known = new Set(parsed.sessions.filter((id): id is string => typeof id === 'string'));
        } catch { return undefined; }
        return known;
    };
    const persist = async (sessions: Set<string>): Promise<void> => {
        const content = JSON.stringify({ version: MARKER_VERSION, sessions: [...sessions] });
        if (await fs.driver.exists(MARKER_PATH)) await fs.driver.writeContent(MARKER_PATH, content);
        else await fs.driver.createFile({ name: 'flow-invocations.json', parentPath: '/var/lib/kernel', content, recursive: true });
    };
    const serialize = (work: () => Promise<void>): Promise<void> => {
        const next = tail.catch(() => {}).then(work);
        tail = next;
        return next;
    };
    return {
        sessions: load,
        mark: sessionId => serialize(async () => {
            const sessions = known ?? await load() ?? new Set<string>();
            if (sessions.has(sessionId)) return;
            sessions.add(sessionId);
            known = sessions;
            await persist(sessions);
        }),
        establish: sessionIds => serialize(async () => {
            const sessions = new Set(sessionIds);
            known = sessions;
            await persist(sessions);
        }),
    };
}
