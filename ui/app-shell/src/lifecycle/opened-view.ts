import {FlowInvocationCommand} from '@itookit/llm-session/contracts';
import type {SessionPresentationState, ApplicationBackend, ApplicationServices, ApplicationViewEvent, ApplicationViewSources, OpenedApplicationView, WorkbenchView} from '@itookit/app-contracts/services';

function overlay<T extends object>(target: T, overrides: Partial<T>): T {
    return new Proxy(target, {get(value, key) {
        if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
        const item = Reflect.get(value, key, value); return typeof item === 'function' ? item.bind(value) : item;
    }});
}

/** Remote events enter once; existing components retain their local subscription contracts. */
export class OpenedViewProjection {
    private readonly listeners = new Map<keyof ApplicationViewSources, Set<(value: unknown) => void>>();
    private readonly buffered: ApplicationViewEvent[] = [];
    private cursor: number;
    private snapshotCursor = 0;
    private hydrating = true;
    private stopped = false;
    private stop?: () => void;
    private flushConnections?: () => void;
    private prepared?: WorkbenchView;
    private recovery?: SessionPresentationState['taskAttachment'];
    private flows?: SessionPresentationState['flowInvocations'];
    private skills?: SessionPresentationState['skills'];
    readonly services: ApplicationServices;
    readonly backend: ApplicationBackend;
    constructor(private readonly view: OpenedApplicationView, services: ApplicationServices, backend: ApplicationBackend) {
        this.cursor = view.cursor;
        this.recovery = view.initial?.taskAttachment; this.flows = view.initial?.flowInvocations; this.skills = view.initial?.skills;
        this.services = this.bindServices(services);
        this.prepared = this.bindWorkbench(view.workbench);
        this.backend = overlay(backend, {
            workbenchView: settings => {const ready = this.prepared; this.prepared = undefined; return ready ? Promise.resolve(ready) : backend.workbenchView(settings);},
            taskAttachment: async (id, key) => {
                const matches = id === view.initial?.sessionId && key === view.taskAttachmentKey;
                const ready = matches ? this.recovery : undefined;
                if (matches) this.recovery = undefined;
                return ready ?? backend.taskAttachment(id, key);
            },
        });
    }
    async start(): Promise<void> {
        const stop = await this.view.observation.observeView(this.cursor, event => this.receive(event));
        if (this.stopped) stop(); else this.stop = stop;
    }
    finishHydration(): void {
        this.hydrating = false;
        for (const event of this.buffered.splice(0)) this.dispatch(event);
        this.flushConnections?.();
    }
    async dispose(): Promise<void> {
        this.stopped = true; this.stop?.(); this.listeners.clear(); this.buffered.length = 0;
        await this.view.dispose();
    }
    private subscribe<K extends keyof ApplicationViewSources>(topic: K, listener: (value: ApplicationViewSources[K]) => void): () => void {
        if (this.stopped) return () => {};
        const listeners = this.listeners.get(topic) ?? new Set(); this.listeners.set(topic, listeners);
        const notify = (value: unknown) => listener(value as ApplicationViewSources[K]); listeners.add(notify);
        return () => {listeners.delete(notify);};
    }
    private receive(event: ApplicationViewEvent): void {
        if (this.stopped || event.sequence <= this.cursor) return;
        if (event.sequence !== this.cursor + 1) throw new Error('Application view event gap');
        this.cursor = event.sequence;
        const currentKernel = event.topic === 'kernel' && event.value.sessionId === this.view.initial?.sessionId;
        const currentRepository = event.topic === 'repository' && (!event.value?.sessionId || event.value.sessionId === this.view.initial?.sessionId);
        if (currentKernel || event.topic === 'session') this.recovery = undefined;
        if (currentKernel || currentRepository) this.flows = undefined;
        if (event.topic === 'skills' || event.topic === 'agents') this.skills = undefined;
        if (this.hydrating) {
            if (this.buffered.length >= 256) throw new Error('Application view notification queue full');
            this.buffered.push(event);
        } else this.dispatch(event);
    }
    private dispatch(event: ApplicationViewEvent): void {
        if (event.topic === 'session' && event.sequence <= this.snapshotCursor) return;
        for (const listener of this.listeners.get(event.topic) ?? []) {
            try {listener(event.value);} catch (error) {console.error('[Application view] Observer failed', error);}
        }
    }
    private bindServices(source: ApplicationServices): ApplicationServices {
        const sessionManager = overlay(source.sessionManager, {
            onGlobalEvent: listener => this.subscribe('global', listener), onEvent: listener => this.subscribe('session', listener),
            getSnapshot: () => {
                const baseline = this.hydrating ? this.view.observation.getSessionBaseline?.() : undefined;
                if (baseline) {this.snapshotCursor = baseline.cursor; return baseline.snapshot;}
                if (this.hydrating) this.snapshotCursor = this.view.observation.getViewCursor();
                return source.sessionManager.getSnapshot();
            },
        });
        const commandBus = overlay(source.commandBus, {execute: ((name: string, args?: {sessionId?: string}) => {
            if (name === FlowInvocationCommand.List && args?.sessionId === this.view.initial?.sessionId && this.flows) {
                const ready = this.flows; this.flows = undefined; return Promise.resolve(ready);
            }
            return source.commandBus.execute(name, args);
        }) as ApplicationServices['commandBus']['execute']});
        return {...source, sessionManager, commandBus,
            agentService: overlay(source.agentService, {onChange: listener => this.subscribe('agents', listener)}),
            llmDriver: overlay(source.llmDriver, {onChange: listener => this.subscribe('agents', listener)}),
            sessionRepository: overlay(source.sessionRepository, {subscribe: listener => this.subscribe('repository', listener)}),
            sessionFiles: overlay(source.sessionFiles, {subscribe: listener => this.subscribe('files', listener)}),
            kernel: {...source.kernel, kernel: overlay(source.kernel.kernel, {onChanged: listener => this.subscribe('kernel', listener)})},
            projects: this.bindProjects(source.projects)};
    }
    private bindProjects(source: ApplicationServices['projects']): ApplicationServices['projects'] {
        return overlay(source, {
            favorites: overlay(source.favorites, {subscribe: listener => this.subscribe('favorites', listener)}),
            drafts: overlay(source.drafts, {onPromoted: listener => this.subscribe('draft', listener)}),
            remoteMounts: source.remoteMounts ? overlay(source.remoteMounts, {onChange: listener => this.subscribe('mounts', listener)}) : undefined,
        });
    }
    private bindWorkbench(view: WorkbenchView): WorkbenchView {
        const chat = view.chat;
        return {...view, initialData: this.view.initial,
            connections: this.bindConnections(view.connections),
            chat: chat ? {...chat,
                configuration: chat.configuration ? overlay(chat.configuration, {subscribe: listener => this.subscribe('configuration', listener)}) : undefined,
                sessionSkills: overlay(chat.sessionSkills, {
                    list: async id => {
                        const matches = id === this.view.initial?.sessionId;
                        const ready = matches ? this.skills : undefined;
                        if (matches) this.skills = undefined;
                        return ready ?? chat.sessionSkills.list(id);
                    },
                    onChange: async (id, listener) => id === this.view.initial?.sessionId
                        ? this.subscribe('skills', event => {if (event.sessionId === id) listener();}) : chat.sessionSkills.onChange(id, listener),
                }),
            } : undefined};
    }
    private bindConnections(source: WorkbenchView['connections']): WorkbenchView['connections'] {
        if (!source || !this.view.connectionInterests) return source;
        let current: string | undefined = JSON.stringify([...new Set(this.view.connectionInterests)].sort());
        let latest = -1;
        let pending: {ids: string[]; revision: number} | undefined;
        const update = async (ids: string[], revision: number) => {
            if (revision <= latest) return;
            latest = revision;
            const next = JSON.stringify([...new Set(ids)].sort());
            if (next === current) return;
            current = undefined;
            await source.update(ids, revision);
            if (revision === latest) current = next;
        };
        this.flushConnections = () => {
            if (pending) void update(pending.ids, pending.revision).catch(error => console.error('[connections]', error));
            pending = undefined;
        };
        return overlay(source, {update: async (ids, revision) => {
            if (this.hydrating) {
                if (!pending || revision > pending.revision) pending = {ids: [...ids], revision};
                return;
            }
            await update(ids, revision);
        }});
    }
}
