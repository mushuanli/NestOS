// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { Workbench } from '../src/core/Workbench';
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
it.each(['full', 'compact'] as const)('opens study from the collapsed %s sidebar menu and preserves lazy writes', async toolbar => {
 vi.stubGlobal('matchMedia', () => ({ matches:false, addEventListener(){}, removeEventListener(){} }));
 const { manager } = await createVFS({rootBackend:new MemoryBackend()}); const fs = await manager.openFileSystem('/');
 await fs.driver.createFile({parentPath:'/',name:'a.mind',content:'A --alpha--.'});
 const sidebar = document.createElement('div'), content = document.createElement('div'); document.body.append(sidebar,content);
 const workbench = new Workbench({files:{fs,cwd:'/'},sidebarContainer:sidebar,editorContainer:content,
  editorConfig:{plugins:['cloze:cloze']},uiOptions:{toolbar}});
 try {
  await workbench.start();
  const button = sidebar.querySelector<HTMLButtonElement>('[data-action="study"]'); expect(button).not.toBeNull();
  const menu = button!.closest('details')!; expect(menu).not.toBeNull(); expect(menu.open).toBe(false); expect(menu.hidden).toBe(false);
  expect(button!.querySelector('svg')).not.toBeNull(); expect(button!.textContent).toBe('');
  expect(button!.getAttribute('aria-label')).toBe('Anki 学习管理');
  menu.open = true; button!.click(); expect(menu.open).toBe(false);
  await vi.waitFor(()=>expect(content.querySelector('.mdx-study')).not.toBeNull());
  await vi.waitFor(()=>expect([...content.querySelectorAll('button')].some(b=>b.textContent==='全部笔记')).toBe(true));
  [...content.querySelectorAll('button')].find(b=>b.textContent==='全部笔记')!.click();
  await vi.waitFor(()=>expect(content.textContent).toContain('未学 1'));
  expect(await fs.driver.exists('/.nestos/cloze-srs.seq')).toBe(false);
  const click = (label: string) => [...content.querySelectorAll('button')].find(button => button.textContent!.startsWith(label))!.click();
  click('开始学习'); click('显示答案');
  expect(await fs.driver.exists('/.nestos/cloze-srs.seq')).toBe(false);
  click('简单');
  await vi.waitFor(() => expect(content.textContent).toContain('本轮已完成'));
  expect(await fs.driver.exists('/.nestos/cloze-srs.seq')).toBe(true);
  click('返回概览');
  await vi.waitFor(() => expect(content.textContent).toContain('暂未到期 1'));
 } finally {await workbench.destroy();await manager.dispose();}
});
