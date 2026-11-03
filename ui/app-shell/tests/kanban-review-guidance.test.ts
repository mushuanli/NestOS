import {expect,it} from 'vitest';
import {kanbanReviewGuidance} from '../src/kanban/host';
it('describes replacement acceptance without claiming a deployment or enabling automatic integration',()=>{
    const guide=kanbanReviewGuidance({} as never,{externalRefs:[{system:'nestos-worktree',id:'tree'}]} as never)!;
    expect(guide.title).toContain('替换当前服务');
    const text=guide.paragraphs.join('\n');
    expect(text).toContain('先停止当前服务');expect(text).toContain('不并行启动第二份服务');
    expect(text).toContain('尚未提供自动切换');expect(text).toContain('不代表当前服务已切换');
    expect(text).toContain('不会自动 commit');expect(text).toContain('已合入主分支');
    expect(kanbanReviewGuidance({} as never,{externalRefs:[]} as never)).toBeUndefined();
});
