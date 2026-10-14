export function installMobileNavigation(): void {
    const button = document.getElementById('mobile-more-button') as HTMLButtonElement;
    const menu = document.getElementById('mobile-more-menu') as HTMLDialogElement;
    button.addEventListener('click', () => menu.showModal());
    menu.addEventListener('close', () => button.setAttribute('aria-expanded', 'false'));
    menu.addEventListener('click', event => { if (event.target === menu) menu.close(); });
    menu.querySelector('.mobile-more-menu__close')?.addEventListener('click', () => menu.close());
    menu.querySelectorAll('.app-nav-btn').forEach(item => item.addEventListener('click', () => menu.close()));
    button.addEventListener('click', () => button.setAttribute('aria-expanded', 'true'));
    window.matchMedia('(min-width: 769px)').addEventListener('change', event => {
        if (event.matches && menu.open) menu.close();
    });
}
