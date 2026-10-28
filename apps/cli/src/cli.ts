import { remoteFilesCommand } from './remote-files-command';
import { startHttpServer } from './http-server';
import { installRuntimeDiagnostics, recordRuntimeDiagnostic, traceRuntimeStage } from './diagnostics';
import { errorDetails } from '@itookit/common';
import { digitalTwinCommand } from './digital-twin-command';
import { sharedMemoryCommand } from './shared-memory-command';
import {
    cancelCommand,
    checkpointsCommand,
    deleteCommand,
    doctorCommand,
    forkCommand,
    graphCommand,
    logsCommand,
    promptCommand,
    rerunCommand,
    exportConfigCommand,
    exportCommand,
    tasksCommand,
    respondCommand,
    resumeCommand,
    runCommand,
    statusCommand,
    validateCommand,
    type CommandOptions,
} from './commands';

interface ParsedArgs {
    command?: string;
    positional: string[];
    options: CommandOptions;
}

async function main(argv: string[]): Promise<number> {
    const parsed = parseArgs(argv);
    recordRuntimeDiagnostic('command.start', { command: parsed.options.http ? 'http' : parsed.options.prompt ? 'prompt' : parsed.command ?? 'help' });
    if (parsed.options.connect && (parsed.options.http || parsed.options.profile || parsed.options.setHome || parsed.options.authDir || parsed.options.certDir || parsed.options.staticDir || parsed.options.auditFile)) throw new Error('--connect cannot be combined with local hosting/profile options');
    if (parsed.options.connect && parsed.options.prompt) throw new Error('--connect uses session send or conversation send, not the standalone prompt runner');
    // Explicit hosting uses the same application server as httpd.
    if (parsed.options.http) {
        await startHttpServer(parsed.options.http, parsed.options);
        return 0;
    }
    // -p / --prompt：直接运行一段 prompt（优先于 command 分发）
    if (parsed.options.prompt) return promptCommand(parsed.options);
    if (['project', 'session', 'conversation', 'connection', 'mcp', 'task', 'flow-run'].includes(parsed.command ?? '')) {
        const {applicationCommand} = await import('./application-command');
        return applicationCommand(parsed.command!, parsed.positional, parsed.options);
    }
    if (parsed.options.flowArgs !== undefined) throw new Error('--flow-args requires a session prepare/send/call-prepare command');
    if (parsed.options.connect) throw new Error('--connect is supported by project/session/conversation/connection/mcp/task/flow-run commands');
    switch (parsed.command) {
        case 'fs': return remoteFilesCommand(parsed.positional, parsed.options);
        case 'twin': return digitalTwinCommand(parsed.positional, parsed.options);
        case 'memory': return sharedMemoryCommand(parsed.positional, parsed.options);
        case 'validate': return validateCommand(parsed.options);
        case 'run': return runCommand(parsed.options);
        case 'graph': return graphCommand(parsed.options);
        case 'runs': return statusCommand(undefined, parsed.options);
        case 'status': return statusCommand(required(parsed.positional[0], 'run-id'), parsed.options);
        case 'logs': return logsCommand(required(parsed.positional[0], 'run-id'), parsed.options);
        case 'resume': return resumeCommand(required(parsed.positional[0], 'run-id'), parsed.options);
        case 'respond': return respondCommand(
            required(parsed.positional[0], 'run-id'),
            required(parsed.positional[1], 'request-id'),
            parsed.options,
        );
        case 'cancel': return cancelCommand(required(parsed.positional[0], 'run-id'), parsed.options);
        case 'delete': return deleteCommand(required(parsed.positional[0], 'run-id'), parsed.options);
        case 'checkpoints': return checkpointsCommand(required(parsed.positional[0], 'run-id'), parsed.options);
        case 'tasks': return tasksCommand(required(parsed.positional[0], 'run-id'), parsed.options);
        case 'rerun': return rerunCommand(required(parsed.positional[0], 'run-id'), parsed.options);
        case 'fork': return forkCommand(required(parsed.positional[0], 'run-id'), parsed.options);
        case 'export-config': return exportConfigCommand(required(parsed.positional[0], 'run-id'), parsed.options);
        case 'export': return exportCommand(required(parsed.positional[0], 'run-id'), parsed.options);
        case 'sandbox':
            if (parsed.positional[0] === 'doctor') return doctorCommand(parsed.options);
            throw new Error('sandbox requires doctor');
        case 'help':
        case undefined:
            process.stdout.write(help());
            return 0;
        default: throw new Error(`Unknown command: ${parsed.command}`);
    }
}

export function parseArgs(argv: string[]): ParsedArgs {
    // 支持 `nestos -p "x"`：参数首位是选项（-p）时无显式 command。
    const isOptionFirst = !argv[0] || argv[0].startsWith('-');
    const command = isOptionFirst ? undefined : argv[0];
    const rest = isOptionFirst ? argv : argv.slice(1);
    const positional: string[] = [];
    const options: CommandOptions = {};
    for (let index = 0; index < rest.length; index++) {
        const arg = rest[index];
        if (arg === '-f' || arg === '--file') options.file = required(rest[++index], 'config path');
        else if (arg === '--connection-bindings') options.connectionBindingsFile = required(rest[++index], 'connection bindings JSON file');
        else if (arg === '--flow-args') options.flowArgs = required(rest[++index], 'Flow argument string');
        else if (arg === '--params') options.paramsFile = required(rest[++index], 'parameters JSON file');
        else if (arg === '-p' || arg === '--prompt') options.prompt = (options.prompt ? `${options.prompt} ` : '') + required(rest[++index], 'prompt');
        else if (arg === '--connect') options.connect = required(rest[++index], 'HTTPS endpoint');
        else if (arg === '--client-cert') options.clientCert = required(rest[++index], 'client certificate');
        else if (arg === '--client-key') options.clientKey = required(rest[++index], 'client key');
        else if (arg === '--ca-cert') options.caCert = required(rest[++index], 'CA certificate');
        else if (arg === '--auth-dir') options.authDir = required(rest[++index], 'authorization directory');
        else if (arg === '--cert-dir') options.certDir = required(rest[++index], 'server certificate directory');
        else if (arg === '--static') options.staticDir = required(rest[++index], 'static UI directory');
        else if (arg === '--audit-file') options.auditFile = required(rest[++index], 'audit file');
        else if (arg === '--agent') options.agent = required(rest[++index], 'agent id');
        else if (arg === '--flow') options.flow = required(rest[++index], 'published Flow id');
        else if (arg === '--submission-file') options.submissionFile = required(rest[++index], 'frozen submission JSON file');
        else if (arg === '--branch') options.branch = required(rest[++index], 'branch name');
        else if (arg === '--call-title') options.callTitle = required(rest[++index], 'independent call title');
        else if (arg === '--transfer') options.transferFile = required(rest[++index], 'content transfer reference JSON file');
        else if (arg === '--context') options.contextFile = required(rest[++index], 'context selection JSON file');
        else if (arg === '--cursor') options.cursor = required(rest[++index], 'pagination cursor JSON');
        else if (arg === '--model') options.model = required(rest[++index], 'model');
        else if (arg === '--api-key-env') options.apiKeyEnv = required(rest[++index], 'api-key-env');
        else if (arg === '--credential-env') options.credentialEnv = required(rest[++index], 'credential environment variable');
        else if (arg === '--base-url') options.baseUrl = required(rest[++index], 'base-url');
        else if (arg === '--protocol') options.protocol = required(rest[++index], 'protocol');
        else if (arg === '--responses-path') options.responsesPath = required(rest[++index], 'responses-path');
        else if (arg === '--no-tools') options.noTools = true;
        else if (arg === '--verbose' || arg === '-v') options.verbose = true;
        else if (arg === '-d' || arg === '--http') options.http = required(rest[++index], '[ip:]port');
        else if (arg === '--state-dir') options.stateDir = required(rest[++index], 'state directory');
        else if (arg === '--out') options.out = required(rest[++index], 'output path');
        else if (arg === '--max-bytes') options.maxBytes = Number(required(rest[++index], 'byte budget'));
        else if (arg === '--retry-indeterminate') options.retryIndeterminate = true;
        else if (arg === '--profile') options.profile = required(rest[++index], 'profile');
        else if (arg === '--set-home') options.setHome = required(rest[++index], 'home directory');
        else if (arg === '--add-dir') options.addDir = [...(options.addDir ?? []), required(rest[++index], 'directory')];
        else if (arg === '--grant-memory') options.grantMemory = [...(options.grantMemory ?? []), required(rest[++index], 'shared Memory resource id')];
        else if (arg === '--headless') options.headless = true;
        else if (arg === '--json') options.json = true;
        else if (arg === '--follow') options.follow = true;
        else if (arg === '--approve') options.approve = true;
        else if (arg === '--deny') options.deny = true;
        else if (arg === '--value') options.value = required(rest[++index], 'response value');
        else if (arg === '--offline') options.offline = true;
        else if (arg === '--sandbox') options.sandbox = sandbox(required(rest[++index], 'sandbox mode'));
        else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        else positional.push(arg);
    }
    return { command, positional, options };
}

function sandbox(value: string): 'native' | 'oci' {
    if (value !== 'native' && value !== 'oci') throw new Error(`Invalid sandbox mode: ${value}`);
    return value;
}

function required(value: string | undefined, label: string): string {
    if (!value) throw new Error(`Missing ${label}`);
    return value;
}

function help(): string {
    return `NestOS CLI\n\n` +
        `  nestos project list|create [name] [--profile data-root] [--json]\n` +
        `  nestos session list | create <project-id> <title> | show <session-id>\n` +
        `  nestos session send|branches|branch|delete-branch <session-id> [text/name] [--agent id] [--branch name]\n` +
        `  nestos flow-run show|cancel|reattach <session-id> <root-task-id>\n` +
        `  nestos flow-run pause|resume|withdraw-pause <session-id> <root-task-id> <request-id> <observed-epoch>\n` +
        `  nestos flow-run receipt <session-id> <root-task-id> <request-id>\n` +
        `  nestos session targets\n` +
        `  nestos session call-prepare <session-id> [text] --agent id | --flow id --call-title title --submission-file call.json [--transfer reference.json]\n` +
        `  nestos session call-submit <session-id> <call.json> [--follow]\n` +
        `  nestos session call-receipt <session-id> <call.json>\n` +
        `  nestos session contexts <session-id> [binding-id] [--cursor json] [--branch name]\n` +
        `  nestos session prepare|send <session-id> [text] --agent id [--context selection.json] [--submission-file call.json]\n` +
        `  nestos session send <session-id> [text] --agent <id> | --flow <id> [--params file]\n` +
        `  nestos session prepare <session-id> [text] --flow <id> --submission-file file\n` +
        `  nestos session submit|receipt <session-id> <submission.json>\n` +
        `  nestos conversation profiles <project-id> | list <project-id> <profile-id> [cursor]\n` +
        `  nestos conversation create <project-id> <profile-id> <workspace-id>\n` +
        `  nestos conversation query <project-id> <profile-id> <session-id> <command> [query-id]\n` +
        `  nestos conversation reconcile-query <project-id> <profile-id> <session-id> <query-id>\n` +
        `  nestos conversation show|send|branches|fork|reconcile|interrupt <project-id> <profile-id> <session-id> [text/name]\n` +
        `  nestos connection list | mcp list | task show|events|cancel <session-id> <task-id>\n` +
        `  --connect https://host:2000 --client-cert file --client-key file --ca-cert file\n` +
        `  nestos validate [-f nestos.yml] [--offline]\n` +
        `  nestos run [-f nestos.yml] [--headless] [--json] [--sandbox native|oci]\n` +
        `  nestos -p "your prompt" [--model provider/model] [--api-key-env ENV] [--base-url URL] [--protocol openai-chat|openai-responses] [--no-tools]\n` +
        `  nestos graph [-f nestos.yml] [--offline]\n` +
        `  nestos runs [--state-dir .nestos]\n` +
        `  nestos status <run-id> [--state-dir .nestos] [--json]\n` +
        `  nestos logs <run-id> [--state-dir .nestos] [--follow]\n` +
        `  nestos resume <run-id> [--state-dir .nestos] [--headless] [--json] [--retry-indeterminate]\n` +
        `  nestos respond <run-id> <request-id> (--approve | --deny | --value <json>) [--state-dir .nestos]\n` +
        `  nestos cancel <run-id> [--state-dir .nestos]\n` +
        `  nestos delete <run-id> [--state-dir .nestos]\n` +
        `  nestos tasks <run-id> [--state-dir .nestos] [--json]\n` +
        `  nestos rerun <run-id> [--state-dir .nestos] [--headless] [--json]\n` +
        `  nestos export-config <run-id> [--state-dir .nestos]\n` +
        `  nestos export <run-id> [--state-dir .nestos] [--out file.json] [--max-bytes N]\n` +
        `  nestos fs list|read|stat|status <endpoint> <alias> [relative-path] [--credential-env ENV] [--out file]\n` +
        `  nestos sandbox doctor\n\n` +
        `  nestos twin list|preview-source|add-source|add-memory|analyze|cancel|review|forget|forget-subject|forget-project|suppress|settings|link-execution|revoke-source|enable-source|remove-source [id] [revision] [decision] [--profile root] [--value JSON]\n` +
        `  nestos twin scan-plans|scan-runs|plan-create|plan-update|plan-pause|plan-enable|plan-delete|plan-run|scan-cancel|scan-tick|watch [id] [revision] [--profile root] [--value JSON]\n` +
        `  nestos memory list|create|inspect|grant|revoke|delete|audit [id] [incarnation] [session] [--profile root] [--value JSON]\n\n` +
        `选项：\n` +
        `  --profile <name>    desktop（默认，共享 ~/.config/nestos）或显式数据根路径\n` +
        `  -d, --http <addr>   启动 HTTP 版 NestOS UI（[ip:]port，默认 127.0.0.1）\n` +
        `  --connect <url>     应用命令连接 HTTPS httpd；默认直接启动本地运行时，不监听端口\n` +
        `  --follow            应用 session send 等待执行结果并输出事件 JSONL\n` +
        `  --state-dir <dir>   运行状态目录；默认 <dataRoot>/var/lib/cli-runs\n` +
        `  --set-home <dir>    将宿主目录挂载到 /workspace 并作为 Session 工作目录（默认 rw）\n` +
        `  --add-dir <dir>     追加宿主目录到 Session 上下文；可重复，默认只读，支持 <dir>:rw\n` +
        `  --grant-memory <id> 显式授权本次 Session 使用该共享记忆的配置范围；可重复\n` +
        `  --headless          无交互模式，事件作为 JSONL 写到 stdout（适合 CI）\n` +
        `  --connection-bindings <file>  .flow connection slot bindings (JSON)\n` +
        `  --flow-args <text> Session Flow 的位置／具名参数，支持 @notes:/file.md 引用\n` +
        `  --params <file>     .flow 或 Session 调用实参（JSON 对象）\n` +
        `  --flow <id>         Session 调用已发布 Flow，与 --agent 互斥\n` +
        `  --submission-file <file>  派发前独占保存冻结请求，供 submit/receipt 复用\n` +
        `  --json              JSON 输出；离线 run 隐含 --headless，应用命令默认输出 JSON\n` +
        `  --offline           校验/查看时不要求 API key 环境变量已存在\n`;
}

const diagnostics = installRuntimeDiagnostics(process.argv.includes('--connect') ? 'cli-remote' : process.argv.includes('-d') || process.argv.includes('--http') ? 'httpd-cli' : 'cli-local');
traceRuntimeStage('cli', () => main(process.argv.slice(2))).then(code => {
    recordRuntimeDiagnostic('command.completed', { code });
    if (code !== 0) process.stderr.write(`[Diagnostics] ${diagnostics.file}\n`);
    process.exitCode = code;
}).catch(error => {
    process.stderr.write(`错误：${errorDetails(error)}\n运行日志：${diagnostics.file}\n`);
    process.exitCode = 2;
});
