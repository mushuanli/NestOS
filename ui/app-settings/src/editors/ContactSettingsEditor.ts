// @file: apps-settings/editors/ContactSettingsEditor.ts
import { Contact } from '../types/types';
import {generateShortUUID} from '@itookit/common';
import { BaseSettingsEditor, Modal, Toast } from '@itookit/ui-common';
import type { SettingsPort as SettingsService } from '@itookit/app-contracts/settings';

export class ContactSettingsEditor extends BaseSettingsEditor<SettingsService> {
    private searchTerm = '';
    private selectedGroup = 'all';

    render() {
        const contacts = this.service.getContacts();
        const filtered = contacts.filter(c => {
            const matchGroup = this.selectedGroup === 'all' || c.group === this.selectedGroup;
            const matchSearch = !this.searchTerm || c.name.toLowerCase().includes(this.searchTerm.toLowerCase());
            return matchGroup && matchSearch;
        });
        
        const groups = Array.from(new Set(contacts.map(c => c.group).filter(Boolean)));

        this.container.innerHTML = `
            <div class="settings-page">
                <div class="settings-page__header">
                    <div>
                        <h2 class="settings-page__title">通讯录</h2>
                        <p class="settings-page__description">管理您的联系人信息</p>
                    </div>
                    <button id="btn-add-contact" class="settings-btn settings-btn--primary">
                        <span class="settings-btn__icon">+</span> 添加联系人
                    </button>
                </div>

                <div class="settings-contact-toolbar">
                    <div class="settings-search-box">
                        <span class="settings-search-box__icon">🔍</span>
                        <input type="text" class="settings-search-box__input" id="contact-search" placeholder="搜索..." value="${this.searchTerm}">
                    </div>
                    <div style="display:flex; gap:10px; flex-wrap:wrap;">
                        <button class="settings-btn settings-btn--sm ${this.selectedGroup === 'all' ? 'settings-btn--primary' : 'settings-btn--secondary'} filter-btn" data-group="all">全部</button>
                        ${groups.map(g => `
                            <button class="settings-btn settings-btn--sm ${this.selectedGroup === g ? 'settings-btn--primary' : 'settings-btn--secondary'} filter-btn" data-group="${g}">${g}</button>
                        `).join('')}
                    </div>
                </div>

                <div class="settings-contact-list">
                    ${filtered.map(c => this.renderContactCard(c)).join('')}
                </div>
            </div>
        `;

        this.bindEvents();
    }

    private renderContactCard(contact: Contact) {
        return `
            <div class="settings-contact-card" data-id="${contact.id}">
                <div class="settings-contact-card__avatar">${contact.name.substring(0, 2)}</div>
                <div class="settings-contact-card__info">
                    <div style="display:flex; justify-content:space-between;">
                        <h3 style="margin:0; font-size:1.1rem;">${contact.name}</h3>
                        ${contact.group ? `<span class="settings-badge">${contact.group}</span>` : ''}
                    </div>
                    <div style="margin:10px 0; color:var(--st-text-secondary); font-size:0.9rem;">
                        ${contact.email ? `<div>📧 ${contact.email}</div>` : ''}
                        ${contact.phone ? `<div>📱 ${contact.phone}</div>` : ''}
                    </div>
                    <div style="display:flex; gap:5px;">
                        <button class="settings-btn settings-btn--sm settings-btn--secondary settings-btn-edit">编辑</button>
                        <button class="settings-btn settings-btn--sm settings-btn--danger settings-btn-delete">删除</button>
                    </div>
                </div>
            </div>
        `;
    }

    private bindEvents() {
        this.clearListeners();

        this.bindButton('#btn-add-contact', () => this.showEditModal(null));

        // Search
        const searchInput = this.container.querySelector('#contact-search');
        if (searchInput) {
            this.addEventListener(searchInput, 'input', (e) => {
                this.searchTerm = (e.target as HTMLInputElement).value;
                this.render();
            });
        }

        // Filter
        this.container.querySelectorAll('.filter-btn').forEach(btn => {
            this.addEventListener(btn, 'click', (e) => {
                this.selectedGroup = (e.target as HTMLElement).dataset.group || 'all';
                this.render();
            });
        });

        // List Actions
        const list = this.container.querySelector('.settings-contact-list');
        if (list) {
            this.addEventListener(list, 'click', (e) => {
                const target = e.target as HTMLElement;
                const card = target.closest('.settings-contact-card') as HTMLElement;
                if (!card) return;
                
                const contact = this.service.getContacts().find(c => c.id === card.dataset.id);
                if (!contact) return;

                if (target.closest('.settings-btn-edit')) this.showEditModal(contact);
                if (target.closest('.settings-btn-delete')) this.deleteContact(contact.id);
            });
        }
    }

    private bindButton(selector: string, handler: () => void) {
        const btn = this.container.querySelector(selector);
        if (btn) this.addEventListener(btn, 'click', handler);
    }

    private showEditModal(contact: Contact | null) {
        const isNew = !contact;
        const html = `
            <form id="contact-form" class="settings-form">
                <div class="settings-form__group"><label class="settings-form__label">姓名</label><input class="settings-form__input" name="name" value="${contact?.name || ''}" required></div>
                <div class="settings-form__group"><label class="settings-form__label">Email</label><input class="settings-form__input" name="email" value="${contact?.email || ''}"></div>
                <div class="settings-form__group"><label class="settings-form__label">分组</label><input class="settings-form__input" name="group" value="${contact?.group || ''}"></div>
            </form>
        `;
        
        new Modal(isNew ? '添加' : '编辑', html, {
            confirmText: '保存',
            onConfirm: async () => {
                const form = document.getElementById('contact-form') as HTMLFormElement;
                if (!form.checkValidity()) return false;
                
                const formData = new FormData(form);
                const newContact: Contact = {
                    id: contact?.id || `contact-${generateShortUUID()}`,
                    name: formData.get('name') as string,
                    email: formData.get('email') as string,
                    group: formData.get('group') as string
                };
                await this.service.saveContact(newContact);
                Toast.success('Saved');
            }
        }).show();
    }

    private deleteContact(id: string) {
        Modal.confirm('删除', '确定删除吗？', async () => {
            await this.service.deleteContact(id);
            Toast.success('Deleted');
        });
    }
}