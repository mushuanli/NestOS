import type { SkillDefinition, SkillToolBinding } from '@itookit/tools/contracts';
import type { ToolExecutionContext } from '@itookit/tools/contracts';
import type { INativeShell } from '@itookit/tools';
import type { SkillToolHandlerFactory } from '../ports/capabilities';
import type { MCPToolAdapter } from '../tool/mcp-tools';

/** Default handlers execute inside the existing cancellable tool.call Effect. */
export function createSkillToolHandlers(mcp: MCPToolAdapter, shell?: INativeShell): SkillToolHandlerFactory {
    return { create(skill, binding) {
        if (binding.executionType === 'mcp' || (binding.executionType === 'handler' && skill.type === 'mcp')) {
            const server = binding.mcpServerId ?? skill.mcpServerId;
            const tool = binding.mcpToolName ?? skill.mcpToolName;
            if (!server || !tool) throw new Error(`MCP binding requires server and tool: ${binding.toolId}`);
            return (args, context) => mcp.call(server, tool, args, context);
        }
        if (binding.executionType === 'http') {
            if (!skill.endpoint) throw new Error(`HTTP Skill requires endpoint: ${skill.id}`);
            return (args, context) => callHttp(skill, args, context);
        }
        if (binding.executionType === 'shell') {
            if (!shell || !binding.command) throw new Error(`Shell binding requires a native shell and command: ${binding.toolId}`);
            return (args, context) => callShell(shell, binding, args, context);
        }
        return undefined;
    } };
}

async function callHttp(skill: SkillDefinition, args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
    const method = (skill.method ?? 'POST').toUpperCase();
    const url = new URL(skill.endpoint!);
    if (method === 'GET' || method === 'HEAD') for (const [key, value] of Object.entries(args)) url.searchParams.set(key, String(value));
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...skill.headers },
        body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(args), signal: context.signal });
    if (!response.ok) throw new Error(`Skill ${skill.id}: HTTP ${response.status}`);
    return response.text();
}

async function callShell(shell: INativeShell, binding: SkillToolBinding, args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
    const interpolate = (text: string, quote: boolean) => text.replace(/\{\{([A-Za-z_][\w]*)\}\}/g, (_match, key: string) => {
        if (!Object.hasOwn(args, key)) throw new Error(`Missing shell argument: ${key}`);
        const value = typeof args[key] === 'string' ? args[key] : JSON.stringify(args[key]);
        return quote ? `'${String(value).replace(/'/g, `'"'"'`)}'` : String(value);
    });
    if (!binding.args && /\{\{/.test(binding.command!) && /['"\\]/.test(binding.command!)) {
        throw new Error('Quoted shell templates require an explicit args array');
    }
    const command = binding.args ? binding.command! : 'sh';
    const argv = binding.args ? binding.args.map(arg => interpolate(arg, false)) : ['-c', interpolate(binding.command!, true)];
    const result = await shell.exec(command, argv, { cwd: context.cwd, signal: context.signal, timeoutMs: context.timeoutMs });
    if (result.code !== 0) throw new Error(`Skill command exited ${result.code}: ${result.stderr}`);
    return result.stdout;
}
