/**
 * 选项页侧边栏导航
 * 纯 DOM：切换 section + 绑定侧边栏点击。
 */

/**
 * 绑定侧边栏导航点击事件
 */
export function setupSidebarNav() {
  document.querySelectorAll('.sidebar-item').forEach(item => {
    // B10：键盘可达（保留 div 标签，补 ARIA + 焦点 + 键盘触发）
    item.setAttribute('tabindex', '0');
    item.setAttribute('role', 'button');
    const activate = () => switchSection(item.dataset.section);
    item.addEventListener('click', activate);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); // 防 Space 触发页面滚动
        activate();
      }
    });
  });
}

/**
 * 切换页面部分
 */
export function switchSection(sectionId) {
  // 隐藏所有部分
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));

  // 显示选中部分
  document.getElementById(sectionId).classList.add('active');
  document.querySelector(`[data-section="${sectionId}"]`).classList.add('active');

  // B8：切换 section 后把主内容区滚动复位到顶（上个 section 滚到底会残留）
  document.querySelector('.main')?.scrollTo(0, 0);
}
