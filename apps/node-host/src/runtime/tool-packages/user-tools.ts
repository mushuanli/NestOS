import type {ToolHistory} from './history';
import type {Tool} from '@itookit/tools';
import type {ToolPreferences} from './preferences';

/** Shared code gets a user-bound gate; core platform primitives are left untouched. */
export function userTool(tool: Tool, preferences: ToolPreferences, packageKey: string, history?: ToolHistory, enableWith?: string, defaultEnabled = false): Tool {
    return new Proxy(tool, {get(target, key) {
        if (key === 'isEnabled') return () => target.isEnabled() && preferences.enabled(packageKey, target.name, defaultEnabled) && (!enableWith || preferences.enabled(packageKey, enableWith));
        if (key === 'call' && history) return (args: Parameters<Tool['call']>[0], context: Parameters<Tool['call']>[1]) => history.call(target, packageKey, args, context);
        if (key === 'inputDefaults') return () => ({...target.inputDefaults?.(), ...preferences.defaults(packageKey, target.name)});
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    }});
}
