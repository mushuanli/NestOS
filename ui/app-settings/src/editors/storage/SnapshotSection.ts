// @file: app-settings/editors/storage/SnapshotSection.ts

import { Toast, Modal } from '@itookit/ui-common';
import type { SettingsPort as SettingsService, LocalSnapshot } from '@itookit/app-contracts/settings';
import { StorageUtils } from './StorageUtils';

export class SnapshotSection {
  private snapshots: LocalSnapshot[] = [];

  constructor(private container: HTMLElement, private service: SettingsService) {}

  async init(): Promise<void> {
    await this.loadSnapshots();
  }

  private async loadSnapshots(): Promise<void> {
    try {
      this.snapshots = await this.service.listLocalSnapshots();
      this.render();
    } catch (e) {
      console.error('Failed to list snapshots:', e);
    }
  }

  render(): void {
    this.container.innerHTML = `
      <div class="settings-section">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
          <div>
            <h3 class="settings-section__title" style="margin: 0">📦 本地快照</h3>
            <p class="settings-page__description" style="margin: 5px 0 0 0;">
              浏览器内的即时备份，用于快速回滚到之前的状态
            </p>
          </div>
          <button id="btn-create-snapshot" class="settings-btn settings-btn--secondary">
            <i class="fas fa-camera"></i> 创建快照
          </button>
        </div>

        <div class="settings-snapshot-list">
          ${this.snapshots.length === 0 ? `
            <div class="settings-empty settings-empty--mini">
              <i class="fas fa-box-open"></i>
              <p>暂无快照，点击上方按钮创建第一个快照</p>
            </div>
          ` : this.snapshots.map(snapshot => `
            <div class="snapshot-item" data-name="${snapshot.name}">
              <div class="snapshot-item__icon">🕰️</div>
              <div class="snapshot-item__info">
                <p class="snapshot-item__title">${StorageUtils.escapeHtml(snapshot.displayName)}</p>
                <p class="snapshot-item__meta">
                  ${new Date(snapshot.createdAt).toLocaleString()} 
                  • ${(snapshot.size / 1024 / 1024).toFixed(2)} MB
                  ${snapshot.description ? ` • ${snapshot.description}` : ''}
                </p>
              </div>
              <div class="settings-snapshot-actions">
                <button class="settings-btn settings-btn--sm settings-btn--secondary btn-restore-snap" 
                  data-name="${snapshot.name}" title="恢复到此快照">
                  <i class="fas fa-undo"></i> 恢复
                </button>
                <button class="settings-btn settings-btn--sm settings-btn--secondary btn-download-snap"
                  data-name="${snapshot.name}" title="下载快照文件">
                  <i class="fas fa-download"></i>
                </button>
                <button class="settings-btn settings-btn--sm settings-btn--danger btn-del-snap" 
                  data-name="${snapshot.name}" title="删除快照">
                  <i class="fas fa-trash"></i>
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    this.bindEvents();
  }

  private bindEvents(): void {
    this.container.querySelector('#btn-create-snapshot')?.addEventListener('click', () => this.createSnapshot());
    
    this.container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const restoreBtn = target.closest('.btn-restore') as HTMLElement;
      const dlBtn = target.closest('.btn-download') as HTMLElement;
      const delBtn = target.closest('.btn-delete') as HTMLElement;

      if (restoreBtn) this.restoreSnapshot(restoreBtn.dataset.name!);
      if (dlBtn) this.downloadSnapshot(dlBtn.dataset.name!);
      if (delBtn) this.deleteSnapshot(delBtn.dataset.name!);
    });
  }

  

  /**
   * 创建快照
   */
  private async createSnapshot(): Promise<void> {
    const btn = this.container.querySelector('#btn-create-snapshot') as HTMLButtonElement;
    if (!btn) return;

    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 创建中...';
    btn.disabled = true;

    try {
      await this.service.createSnapshot();
      Toast.success('快照创建成功');
      await this.loadSnapshots();
    } catch (e: any) {
      Toast.error('创建快照失败: ' + e.message);
    } finally {
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    }
  }

  /**
   * 恢复快照
   */
  private restoreSnapshot(name: string): void {
    const snapshot = this.snapshots.find(s => s.name === name);
    if (!snapshot) return;

    Modal.confirm(
      '⚠️ 确认恢复快照',
      `<div style="line-height: 1.6;">
        <p><b>警告：此操作将覆盖当前所有数据！</b></p>
        <p>系统将回滚到 <b>${snapshot.displayName}</b> 的状态。</p>
        <p style="color: var(--st-text-secondary);">
          创建时间: ${new Date(snapshot.createdAt).toLocaleString()}
        </p>
        <p>建议先创建一个当前状态的快照以便恢复。</p>
      </div>`,
      async () => {
        try {
          Toast.info('正在恢复快照...');
          await this.service.restoreSnapshot(name);
          Toast.success('快照恢复成功，页面即将刷新...');
          setTimeout(() => window.location.reload(), 1500);
        } catch (e: any) {
          Toast.error('恢复失败: ' + e.message);
        }
      }
    );
  }

  /**
   * 下载快照
   */
  private async downloadSnapshot(name: string): Promise<void> {
    try {
      const data = await this.exportSnapshot(name);
      const snapshot = this.snapshots.find(s => s.name === name);
      const filename = `snapshot-${snapshot?.displayName || name}-${new Date().toISOString().slice(0, 10)}.json`;
      StorageUtils.downloadJson(data, filename);
      Toast.success('快照已下载');
    } catch (e: any) {
      Toast.error('下载失败: ' + e.message);
    }
  }

  /**
   * 删除快照
   */
  private async deleteSnapshot(name: string): Promise<void> {
    const snapshot = this.snapshots.find(s => s.name === name);
    if (!snapshot) return;

    Modal.confirm(
      '删除快照',
      `确定要删除快照 "<b>${snapshot.displayName}</b>" 吗？此操作不可撤销。`,
      async () => {
        try {
          await this.service.deleteSnapshot(name);
          Toast.success('快照已删除');
          await this.loadSnapshots();
        } catch (e: any) {
          Toast.error('删除失败: ' + e.message);
        }
      }
    );
  }

    /**
   * 导出快照为 JSON 数据
   */
  async exportSnapshot(name: string): Promise<object> {
    // 获取快照数据
    const snapshot = await this.getSnapshotData(name);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${name}`);
    }
    
    return {
      meta: {
        name,
        exportedAt: Date.now(),
        version: '1.0'
      },
      data: snapshot
    };
  }

  /**
   * 获取快照原始数据
   */
  private async getSnapshotData(name: string): Promise<any> {
    // 实现快照数据获取逻辑
    // 这里需要根据你的实际存储方式来实现
    const db = await this.openSnapshotDB();
    return db.get('snapshots', name);
  }
  private async openSnapshotDB():Promise<any> {
    // TODO:
  }
}
