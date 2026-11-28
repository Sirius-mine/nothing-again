/* ============================================================
 * 无事 · 木鱼 —— 管理台入口
 * 文件：assets/admin-entry.js
 *
 * 作用：如果当前浏览器里登录的是管理员账号，就在主站顶部
 *      「用户信息」旁边加一个「管理台」按钮。
 *
 * 说明：
 *   - 只读主站 supabase-js 存在 localStorage 的会话，不修改它；
 *   - 不会刷新令牌（避免和管理台、主站抢同一个 refresh token）；
 *   - 不是管理员时什么也不做。
 * ============================================================ */

const CONFIG = Object.freeze({
  supabaseUrl: 'https://emjwffqoctwpwfcsqzhu.supabase.co',
  publishableKey: 'sb_publishable_U1THwAmBfhNSTIUchkNUuA_LKf7jywv',
  siteSessionKey: 'sb-emjwffqoctwpwfcsqzhu-auth-token',
  buttonId: 'adminEntryButton',
});

(() => {
  let checking = false;
  let timer = 0;

  function readSession() {
    try {
      const raw = localStorage.getItem(CONFIG.siteSessionKey);
      if (!raw) return null;
      const value = JSON.parse(raw);
      return value && typeof value.access_token === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  function nav() {
    return document.querySelector('.account-nav');
  }

  function removeButton() {
    document.getElementById(CONFIG.buttonId)?.remove();
  }

  function addButton() {
    const container = nav();
    if (!container) return;
    if (document.getElementById(CONFIG.buttonId)) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.id = CONFIG.buttonId;
    button.textContent = '管理台';
    button.title = '进入管理员后台';
    button.addEventListener('click', () => {
      window.location.href = './admin.html';
    });
    container.appendChild(button);
  }

  async function check() {
    if (checking || document.visibilityState === 'hidden') return;
    const session = readSession();
    if (!session) {
      removeButton();
      return;
    }

    checking = true;
    try {
      const response = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/is_admin`, {
        method: 'POST',
        headers: {
          apikey: CONFIG.publishableKey,
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
        cache: 'no-store',
      });
      if (!response.ok) {
        removeButton();
        return;
      }
      const isAdmin = await response.json();
      if (isAdmin === true) addButton();
      else removeButton();
    } catch {
      // 网络失败时保留现状，不打扰用户。
    } finally {
      checking = false;
    }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(check, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      check();
      schedule();
    });
  } else {
    check();
    schedule();
  }

  window.addEventListener('storage', (event) => {
    if (event.key === CONFIG.siteSessionKey) check();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });

  // 主站登录 / 退出后尽快刷新入口按钮。
  document.addEventListener('click', (event) => {
    if (event.target.closest('#loginButton, #signupButton, #logoutButton')) {
      setTimeout(check, 900);
    }
  });
})();
