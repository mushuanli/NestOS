import {readFile, stat, lstat, mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';

export const CLIENTS_URL = 'https://console.cloud.google.com/auth/clients';
export const inputError = (code, message) => Object.assign(new Error(message), {code});
export const usage = '运行 node tools/nestos-googlecli/node/authorize.mjs，按提示选择客户端文件和权限。\n也可指定 --client /实际路径/client.json [--services gmail,calendar] [--output /私有目录/connection.json]。';

export function parseOptions(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i += 2) {
        if (argv[i] === '--help' || argv[i] === '-h') return {help: true};
        if (!['--client', '--output', '--services'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--'))
            throw inputError('GOOGLE_ARGUMENT_INVALID', usage);
        if (options[argv[i].slice(2)]) throw inputError('GOOGLE_ARGUMENT_INVALID', '参数重复。\n' + usage);
        options[argv[i].slice(2)] = argv[i + 1];
    }
    if (options.services && !['gmail', 'calendar', 'gmail,calendar', 'calendar,gmail'].includes(options.services))
        throw inputError('GOOGLE_SERVICES_INVALID', '服务参数应为 gmail、calendar 或 gmail,calendar。');
    return options;
}
export function clientPath(value) {
    let file = value.trim();
    if (file.length >= 2 && ["'", '"'].includes(file[0]) && file.at(-1) === file[0]) file = file.slice(1, -1);
    file = file.replace(/\\ /g, ' ');
    if (!file) throw inputError('GOOGLE_CLIENT_PATH_REQUIRED', '请粘贴下载的客户端 JSON 文件的实际路径。');
    return path.resolve(file.startsWith('~/') ? path.join(homedir(), file.slice(2)) : file);
}
export async function readDesktopClient(file, io = {readFile, stat}) {
    let text;
    try {
        const info = await io.stat(file);
        if (!info.isFile()) throw inputError('GOOGLE_CLIENT_NOT_FILE', '客户端路径不是文件，请选择下载的 JSON 文件。');
        if (info.size > 65536) throw inputError('GOOGLE_CLIENT_FILE_TOO_LARGE', '客户端文件超过 64 KiB，请检查是否选错文件。');
        text = await io.readFile(file, 'utf8');
    } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw inputError('GOOGLE_CLIENT_FILE_NOT_FOUND', '找不到客户端文件。desktop-client.json 只是示例文件名；请使用 Google 下载文件的实际路径。相对路径从当前工作目录查找。');
        if (['EACCES', 'EPERM'].includes(error.code)) throw inputError('GOOGLE_CLIENT_FILE_UNREADABLE', '没有权限读取客户端文件，请检查文件权限。');
        if (error.code?.startsWith('GOOGLE_')) throw error;
        throw inputError('GOOGLE_CLIENT_READ_FAILED', '读取客户端文件失败，请检查文件是否可用。');
    }
    let value;
    try {value = JSON.parse(text.replace(/^\uFEFF/, ''));}
    catch {throw inputError('GOOGLE_CLIENT_JSON_INVALID', '文件不是有效的 JSON，请重新下载 Google 客户端文件，不要粘贴网页内容。');}
    if (value?.web && !value.installed) throw inputError('GOOGLE_CLIENT_TYPE_INVALID', '选中了 Web 应用客户端。本地助手需要“桌面应用”客户端；Web 客户端请在 NestOS 管理员授权配置中使用。');
    const client = value?.installed;
    if (!client || ['client_id', 'client_secret'].some(key => typeof client[key] !== 'string' || !client[key].trim()))
        throw inputError('GOOGLE_CLIENT_FIELDS_MISSING', '文件缺少桌面客户端身份。请下载“桌面应用”的 OAuth JSON，不要使用服务账号或已有授权结果文件。');
    return {client_id: client.client_id, client_secret: client.client_secret};
}
export async function promptOptions(options, question, info = console.info) {
    info('首次使用：打开 ' + CLIENTS_URL + '，选择项目，创建“桌面应用”客户端并下载 JSON。');
    info('请在运行此助手的同一台电脑上打开授权链接；httpd 可以在另一台机器。');
    let config;
    while (!config) {
        if (!options.client) options.client = await question('客户端 JSON 文件路径（可拖入文件）：');
        try {
            options.client = clientPath(options.client);
            config = await readDesktopClient(options.client);
        } catch (error) {info(error.message); options.client = undefined;}
    }
    while (!options.services) {
        const choice = (await question('读取哪些内容？1 邮件和日历（默认） / 2 仅邮件 / 3 仅日历：')).trim() || '1';
        options.services = {'1': 'gmail,calendar', '2': 'gmail', '3': 'calendar'}[choice];
        if (!options.services) info('请输入 1、2 或 3。');
    }
    return {...options, config};
}
export async function prepareOptions(argv, input = process.stdin, output = process.stdout) {
    let options = parseOptions(argv); if (options.help) return options;
    if (input.isTTY) {
        const terminal = createInterface({input, output}), cancel = new AbortController();
        terminal.on('SIGINT', () => cancel.abort()); terminal.on('close', () => cancel.abort());
        try {options = await promptOptions(options, prompt => terminal.question(prompt, {signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(300000)])}));}
        catch (error) {
            if (cancel.signal.aborted) throw inputError('GOOGLE_INPUT_CANCELLED', '已取消授权，未保存连接。');
            if (error.name === 'AbortError' || error.name === 'TimeoutError') throw inputError('GOOGLE_INPUT_TIMEOUT', '等待输入超时，请重新运行命令。');
            throw error;
        } finally {terminal.close();}
    } else {
        if (!options.client) throw inputError('GOOGLE_CLIENT_PATH_REQUIRED', '非交互终端需要提供 --client 的实际文件路径。\n' + usage);
        options.client = clientPath(options.client); options.config = await readDesktopClient(options.client);
    }
    options.services ??= 'gmail,calendar';
    options.output = options.output ? clientPath(options.output) : path.join(homedir(), '.config', 'nestos', 'private-exports', 'google-' + randomUUID() + '.json');
    try {await lstat(options.output); throw inputError('GOOGLE_OUTPUT_EXISTS', '输出文件已存在，不会覆盖。请使用另一个 --output 路径。');}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
    await mkdir(path.dirname(options.output), {recursive: true, mode: 0o700});
    return options;
}
