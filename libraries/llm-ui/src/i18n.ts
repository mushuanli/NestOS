const zh = {
    send: '发送', cancel: '停止', retry: '重新生成', edit: '编辑', save: '保存', close: '取消',
    copy: '复制', print: '打印', earlier: '加载更早消息', refresh: '刷新', attach: '添加附件',
    remove: '移除', pending: '提交中', accepted: '已接纳', rejected: '提交被拒绝', unknown: '结果待核对',
    reconcile: '核对操作', upload: '上传中', failed: '操作失败', required: '请填写必填项',
    range: '选择数量不符合要求', reasoning: '思考', unsupported: '未登记的扩展', input: '输入消息',
    answer: '提交回答', note: '说明', prompts: '提问目录', loading: '加载中',
    online: '已连接', offline: '离线', reconnecting: '重新连接中',
    flow: 'Flow',
};
const en: Record<keyof typeof zh, string> = {
    send: 'Send', cancel: 'Stop', retry: 'Regenerate', edit: 'Edit', save: 'Save', close: 'Cancel',
    copy: 'Copy', print: 'Print', earlier: 'Load earlier messages', refresh: 'Refresh', attach: 'Attach files',
    remove: 'Remove', pending: 'Submitting', accepted: 'Accepted', rejected: 'Rejected', unknown: 'Outcome unknown',
    reconcile: 'Reconcile', upload: 'Uploading', failed: 'Operation failed', required: 'Complete required fields',
    range: 'Invalid number of selections', reasoning: 'Reasoning', unsupported: 'Unregistered extension', input: 'Message',
    answer: 'Submit answer', note: 'Note', prompts: 'Questions', loading: 'Loading',
    online: 'Connected', offline: 'Offline', reconnecting: 'Reconnecting',
    flow: 'Flow',
};
export type Translate = (key: keyof typeof zh) => string;
export function translator(locale = 'zh-CN', override?: (key: string) => string): Translate {
    return key => override?.(key) ?? (locale === 'en' ? en : zh)[key];
}
