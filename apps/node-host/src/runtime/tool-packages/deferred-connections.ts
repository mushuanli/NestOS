import type {ToolConnectionAccess, ToolConnectionType} from '@itookit/app-contracts/services';
import {validateToolConnectionDefinition} from '../tool-connections';
import {packageError} from './manifest';

/** Factories can declare metadata during preparation; user data stays inaccessible until commit. */
export function deferredConnections(real?: ToolConnectionAccess) {
    const types = new Map<string, ToolConnectionType>(); let active = false;
    const denied = () => {throw packageError('TOOL_PACKAGE_STAGE_CONNECTION_ACCESS_DENIED', 'Inactive factories cannot access user account data');};
    const access = new Proxy({} as ToolConnectionAccess, {get: (_target, key) => {
        if (key === 'register') return (type: ToolConnectionType) => {validateToolConnectionDefinition(type); types.set(type.id, structuredClone(type));};
        if (key === 'snapshot') return () => active && real ? real.snapshot() : Promise.resolve({types: [...types.values()], connections: []});
        const value = real && Reflect.get(real, key, real);
        if (typeof value === 'function') return (...args: unknown[]) => {if (!active) denied(); return value.apply(real, args);};
        return value;
    }});
    return {access: real ? access : undefined, types,
        prepare() {
            const registration = types.size ? real?.prepareRegistration?.([...types.values()]) : undefined;
            if (types.size && !registration) throw packageError('TOOL_PACKAGE_CONNECTION_UPDATE_UNAVAILABLE', 'The connection host cannot publish definitions atomically');
            return {commit: () => {registration?.commit(); active = true;}, rollback: () => {active = false; registration?.rollback();}};
        }, activateHistorical() {active = true;}};
}
