import type { ProjectService } from '@itookit/app-contracts/services';

/** Poll only while the workbench exists; deadlines bound a stalled server. */
export function monitorRemoteConnections(projects: ProjectService): () => void {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
        try {
            const projectsList = await projects.list();
            for (const project of projectsList) {
                if (controller.signal.aborted) return;
                await projects.remoteMounts?.checkConnections(project.project.id, { signal: controller.signal, timeoutMs: 3000 });
            }
        } finally { if (!controller.signal.aborted) timer = setTimeout(() => { void poll().catch(() => {}); }, 15_000); }
    };
    void poll().catch(() => {});
    return () => { controller.abort(); clearTimeout(timer); };
}
