const zh = {
    send: '发送', cancel: '停止', retry: '重新生成', edit: '编辑', save: '保存', close: '取消',
    copy: '复制', print: '打印', earlier: '加载更早消息', refresh: '刷新', attach: '添加附件',
    remove: '移除', pending: '提交中', accepted: '已接纳', rejected: '提交被拒绝', unknown: '结果待核对',
    reconcile: '核对操作', upload: '上传中', failed: '操作失败', required: '请填写必填项',
    range: '选择数量不符合要求', reasoning: '思考', unsupported: '未登记的扩展', input: '输入消息',
    answer: '提交回答', note: '说明', prompts: '提问目录', loading: '加载中',
    unsupportedInteraction: '当前界面不支持此交互，请使用原生客户端处理。',
    online: '已连接', offline: '离线', reconnecting: '重新连接中',
    commandAmbiguous: '命令同名，请在菜单中选择来源', commandUnavailable: '命令已变化或当前不可用',
    flow: 'Flow',
    search: '搜索内容', searchPlaceholder: '输入搜索内容', searchPrevious: '上一项', searchNext: '下一项',
    searchClose: '关闭搜索', searchScope: '已加载的对话内容', searchNoResults: '无匹配结果',
};
const en: Record<keyof typeof zh, string> = {
    send: 'Send', cancel: 'Stop', retry: 'Regenerate', edit: 'Edit', save: 'Save', close: 'Cancel',
    copy: 'Copy', print: 'Print', earlier: 'Load earlier messages', refresh: 'Refresh', attach: 'Attach files',
    remove: 'Remove', pending: 'Submitting', accepted: 'Accepted', rejected: 'Rejected', unknown: 'Outcome unknown',
    reconcile: 'Reconcile', upload: 'Uploading', failed: 'Operation failed', required: 'Complete required fields',
    range: 'Invalid number of selections', reasoning: 'Reasoning', unsupported: 'Unregistered extension', input: 'Message',
    answer: 'Submit answer', note: 'Note', prompts: 'Questions', loading: 'Loading',
    unsupportedInteraction: 'This interaction is unsupported. Use the native client to respond.',
    online: 'Connected', offline: 'Offline', reconnecting: 'Reconnecting',
    commandAmbiguous: 'Select the source of this ambiguous command', commandUnavailable: 'Command changed or is unavailable',
    flow: 'Flow',
    search: 'Find content', searchPlaceholder: 'Search conversation content', searchPrevious: 'Previous match', searchNext: 'Next match',
    searchClose: 'Close search', searchScope: 'Loaded conversation content', searchNoResults: 'No matches',
};
export type Translate = (key: keyof typeof zh) => string;
export function translator(locale = 'zh-CN', override?: (key: string) => string): Translate {
    return key => override?.(key) ?? (locale === 'en' ? en : zh)[key];
}
