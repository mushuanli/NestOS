import type {DigitalTwinService} from './service';

/** Returns separately bound handles. There is no process-wide selected workspace. */
export function bindTwinWorkspaces(services: DigitalTwinService[]): void {
    const catalog = {
        async list() {
            const views = await Promise.all(services.map(async service => {
                try {return await service.workspaceView();} catch {return null;}
            }));
            return views.filter((view): view is NonNullable<typeof view> => view !== null);
        },
        async open(id: string) {
            for (const service of services) {
                let view;
                try {view = await service.workspaceView();} catch {continue;}
                if (view.id === id) return service;
            }
            throw new Error('TWIN_WORKSPACE_ACCESS_DENIED');
        },
    };
    services.forEach(service => service.setWorkspaceCatalog(catalog));
}
