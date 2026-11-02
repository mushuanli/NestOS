import type {FSEvent} from '@itookit/vfs-core';

type Listener = (event: FSEvent) => void;
type Stop = (() => void) & {ready?: Promise<unknown>};
interface Registration {listener: Listener}
interface Connection {stop?: Stop}
type Subscribe = (listener: Listener) => Stop;
interface ProxyObservers {onAny?: Subscribe; on?: unknown}
interface Group {onAny: Subscribe; on(type: string, listener: Listener): Stop; update(subscribe: Subscribe): void}
const groups = new WeakMap<object, Group>();

/** One remote callback per capability, with independent local event interests. */
export function shareFileObservers(proxy: ProxyObservers): void {
    if (!proxy.onAny) return;
    let group = groups.get(proxy);
    if (group && proxy.onAny === group.onAny) {proxy.on = group.on; return;}
    if (group) group.update(proxy.onAny.bind(proxy));
    else {group = observerGroup(proxy.onAny.bind(proxy)); groups.set(proxy, group);}
    proxy.onAny = group.onAny; proxy.on = group.on;
}
function observerGroup(initial: Subscribe): Group {
    let subscribe = initial;
    const listeners = new Set<Registration>(); let connection: Connection | undefined;
    const connect = () => {
        if (connection) return;
        const active: Connection = {}; connection = active;
        try {
            active.stop = subscribe(event => {if (connection === active) deliver(listeners, event);});
            void active.stop.ready?.catch(() => {if (connection === active) connection = undefined;});
        } catch (error) {connection = undefined; throw error;}
    };
    const onAny: Subscribe = listener => {
        const registration = {listener}; listeners.add(registration);
        try {connect();} catch (error) {listeners.delete(registration); throw error;}
        return () => {
            if (!listeners.delete(registration) || listeners.size) return;
            const previous = connection; connection = undefined; previous?.stop?.();
        };
    };
    return {onAny, on: (type, listener) => onAny(event => {if (event.type === type) listener(event);}), update: next => {subscribe = next;}};
}
function deliver(listeners: Set<Registration>, event: FSEvent): void {
    let failed = false, failure: unknown;
    for (const registration of [...listeners]) {
        if (!listeners.has(registration)) continue;
        try {registration.listener(event);} catch (error) {if (!failed) {failed = true; failure = error;}}
    }
    if (failed) throw failure;
}
