/* ============================================================
 * 无事 · 木鱼 —— 管理台前端
 * 文件：assets/admin.js
 *
 * 设计要点：
 *   - 不依赖 @supabase/supabase-js，直接用 fetch 调 GoTrue / PostgREST；
 *   - 浏览器端只使用 Publishable key，永不接触 service_role；
 *   - 所有权限判断都在数据库函数里完成（is_admin）；
 *   - 用户名 → 合成登录邮箱：sha256(NFKC/trim/小写)@accounts.muyu.invalid。
 * ============================================================ */

const CONFIG = Object.freeze({
  supabaseUrl: 'https://emjwffqoctwpwfcsqzhu.supabase.co',
  publishableKey: 'sb_publishable_U1THwAmBfhNSTIUchkNUuA_LKf7jywv',
  siteSessionKey: 'sb-emjwffqoctwpwfcsqzhu-auth-token',
  adminSessionKey: 'muyu.admin.session',
  skipAdoptKey: 'muyu.admin.skipAdopt',
});

const $ = (id) => document.getElementById(id);

const state = {
  session: null,
  selfId: null,
  adminName: '',
  users: [],
  summary: null,
  filter: '',
  editUser: null,
  deleteUser: null,
  toastTimer: 0,
  searchTimer: 0,
};

class SessionError extends Error {}

/* ---------------- 基础工具 ---------------- */

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeName(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}

function displayName(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function validName(value) {
  return /^[\p{L}\p{N}_-]{2,24}$/u.test(normalizeName(value));
}

function passwordBytes(value) {
  return new TextEncoder().encode(String(value ?? '')).length;
}

async function identityAddress(username) {
  const canonical = normalizeName(username);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex}@accounts.muyu.invalid`;
}

function formatNumber(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('zh-CN');
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(date);
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function isBanned(user) {
  if (!user?.banned_until) return false;
  const until = new Date(user.banned_until).getTime();
  return Number.isFinite(until) && until > Date.now();
}

function jwtSub(token) {
  try {
    let payload = String(token).split('.')[1] || '';
    payload = payload.replace(/-/g, '+').replace(/_/g, '/');
    payload += '='.repeat((4 - (payload.length % 4)) % 4);
    const json = JSON.parse(atob(payload));
    return json.sub || null;
  } catch {
    return null;
  }
}

function randomPassword(length = 16) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return Array.from(values, (v) => alphabet[v % alphabet.length]).join('');
}

function showMessage(el, text, kind = '') {
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', kind === 'ok');
}

function toast(message, kind = '') {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', kind === 'error');
  el.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    el.hidden = true;
  }, kind === 'error' ? 7000 : 4200);
}

/* ---------------- 网络层 ---------------- */

async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
  const finalHeaders = { apikey: CONFIG.publishableKey, ...headers };
  if (token) finalHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(CONFIG.supabaseUrl + path, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new Error('网络连接失败，请检查网络后重试。');
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { res, data };
}

function errorMessage(data, status) {
  const raw =
    (data && typeof data === 'object' && (data.message || data.error_description || data.msg || data.error)) ||
    (typeof data === 'string' ? data : '') ||
    '';

  const map = {
    not_authorized: '当前账号没有管理员权限。',
    user_not_found: '找不到该账户，可能已被删除。',
    name_taken: '这个用户名已经被占用了。',
    email_taken: '这个登录身份已经被占用，请换一个用户名。',
    invalid_username: '用户名需为 2 至 24 个汉字、字母、数字、下划线或短横线，不能含空格或点号。',
    invalid_title: '头衔最多 12 个字。',
    invalid_total: '分数必须是不小于 0 的整数。',
    invalid_password: '密码需为 8 至 72 字节。',
    invalid_login_email: '登录身份格式不正确，请刷新页面后重试。',
    cannot_delete_self: '不能删除当前登录的管理员账户。',
    insufficient_privilege: '当前账号没有管理员权限。',
  };
  if (map[raw]) return map[raw];

  if (/Invalid login credentials/i.test(raw)) return '用户名或密码不正确。';
  if (/Email not confirmed/i.test(raw)) return '该账户未验证邮箱，请联系管理员。';
  if (/banned/i.test(raw)) return '该账号已被封禁，无法登录管理台。';
  if (/Password should be at least/i.test(raw)) return '密码太短，至少需要 8 位。';
  if (/Could not find the function|PGRST202/i.test(raw)) {
    return '数据库还没有安装管理函数，请先执行 supabase/admin-panel.sql。';
  }
  if (/rate limit|too many requests/i.test(raw)) return '操作过于频繁，请稍后再试。';
  if (status === 429) return '操作过于频繁，请稍后再试。';
  if (status === 403) return map[raw] || '没有权限执行这个操作。';
  if (status === 401) return '登录状态已过期，请重新登录。';
  if (raw) return raw;
  return `请求失败（HTTP ${status}）。`;
}

async function callRpc(session, name, args) {
  const { res, data } = await request(`/rest/v1/rpc/${name}`, {
    method: 'POST',
    body: args || {},
    token: session.access_token,
  });
  return { res, data, unauthorized: res.status === 401 };
}

function readJsonStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonStorage(key, value) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {
    /* 隐私模式下忽略 */
  }
}

function siteSession() {
  const raw = readJsonStorage(CONFIG.siteSessionKey);
  if (!raw || !raw.access_token) return null;
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token || null,
    expires_at: Number(raw.expires_at) || null,
    user: raw.user || null,
    source: 'site',
  };
}

function persistSession(session) {
  state.session = session;
  writeJsonStorage(CONFIG.adminSessionKey, session);
}

function clearSession() {
  state.session = null;
  writeJsonStorage(CONFIG.adminSessionKey, null);
}

function skipAdopt() {
  try {
    localStorage.setItem(CONFIG.skipAdoptKey, '1');
  } catch {
    /* ignore */
  }
}

function allowAdopt() {
  try {
    localStorage.removeItem(CONFIG.skipAdoptKey);
  } catch {
    /* ignore */
  }
}

function isAdoptSkipped() {
  try {
    return localStorage.getItem(CONFIG.skipAdoptKey) === '1';
  } catch {
    return false;
  }
}

function sessionFromToken(data, source) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: Number(data.expires_at) || (nowSeconds() + Number(data.expires_in || 3600)),
    user: data.user || null,
    source,
  };
}

async function refreshOwnSession(session) {
  if (!session.refresh_token) throw new SessionError('登录状态已过期，请重新登录。');
  const { res, data } = await request('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: session.refresh_token },
  });
  if (!res.ok) {
    clearSession();
    throw new SessionError('登录状态已过期，请重新登录。');
  }
  const next = sessionFromToken(data, 'own');
  persistSession(next);
  return next;
}

async function recoverSession(session) {
  if (session.source === 'own') {
    return refreshOwnSession(session);
  }
  // 主站会话：绝不在管理台刷新（刷新令牌轮换会让主站掉线）。
  // 但主站可能已经自己换了新 token，重新读一次。
  const fresh = siteSession();
  if (fresh && fresh.access_token && fresh.access_token !== session.access_token) {
    persistSession({ ...fresh, source: 'site' });
    return state.session;
  }
  throw new SessionError('主站登录状态已过期。请用用户名密码登录管理台，或回主站重新登录。');
}

async function rpc(name, args = {}, { retry = true } = {}) {
  if (!state.session) throw new SessionError('尚未登录。');
  let result = await callRpc(state.session, name, args);

  if (result.unauthorized && retry) {
    state.session = await recoverSession(state.session);
    result = await callRpc(state.session, name, args);
  }
  if (result.unauthorized) {
    throw new SessionError('登录状态已过期，请重新登录。');
  }
  if (!result.res.ok) {
    throw new Error(errorMessage(result.data, result.res.status));
  }
  return result.data;
}

/* ---------------- 登录 ---------------- */

async function signInWithPassword(username, password) {
  if (!validName(username)) {
    throw new Error('用户名需为 2 至 24 个汉字、字母、数字、下划线或短横线。');
  }
  const email = await identityAddress(username);
  const { res, data } = await request('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
  });
  if (!res.ok) {
    throw new Error(errorMessage(data, res.status));
  }
  allowAdopt();
  const session = sessionFromToken(data, 'own');
  state.session = session;
  state.selfId = data.user?.id || jwtSub(session.access_token);
  try {
    await assertAdmin();
  } catch (error) {
    state.session = null;
    state.selfId = null;
    throw error;
  }
  persistSession(session);
}

async function assertAdmin() {
  const ok = await rpc('is_admin');
  if (ok !== true) {
    throw new Error('该账户没有管理员权限。');
  }
}

async function adoptSiteLogin() {
  const session = siteSession();
  if (!session) throw new Error('主站没有可用的登录状态，请先在主站登录管理员账号。');
  state.session = session;
  state.selfId = session.user?.id || jwtSub(session.access_token);
  try {
    await assertAdmin();
  } catch (error) {
    clearSession();
    throw error;
  }
  allowAdopt();
  persistSession(session);
}

/* ---------------- 页面切换 ---------------- */

function updateAdoptVisibility() {
  const hasSite = !!siteSession();
  $('adoptSiteSession').hidden = !hasSite;
}

function showLogin(message = '') {
  $('loginPanel').hidden = false;
  $('consolePanel').hidden = true;
  $('adminSession').hidden = true;
  $('signOutButton').hidden = true;
  showMessage($('loginMessage'), message);
  updateAdoptVisibility();
  const name = siteSession()?.user?.user_metadata?.full_name;
  $('adoptSiteSession').textContent = name
    ? `使用主站账号「${name}」的登录状态进入`
    : '使用主站当前的登录状态进入';
}

async function enterConsole() {
  $('loginPanel').hidden = true;
  $('consolePanel').hidden = false;
  $('adminSession').hidden = false;
  $('signOutButton').hidden = false;

  const meta = state.session?.user?.user_metadata || {};
  state.adminName = meta.full_name || meta.name || '管理员';
  $('adminName').textContent = state.adminName;

  await loadUsers();
}

/* ---------------- 数据加载 ---------------- */

async function loadUsers() {
  showMessage($('listMessage'), '正在读取账户…');
  try {
    const [rows, summary] = await Promise.all([
      rpc('admin_list_users'),
      rpc('get_public_stats').catch(() => null),
    ]);
    state.users = Array.isArray(rows) ? rows : [];
    state.summary = Array.isArray(summary) ? summary[0] : summary;

    if (!state.selfId) {
      state.selfId = state.session?.user?.id || jwtSub(state.session?.access_token || '');
    }
    const self = state.users.find((u) => u.user_id === state.selfId);
    if (self) {
      state.adminName = self.username;
      $('adminName').textContent = self.username;
    }

    $('statUsers').textContent = formatNumber(state.summary?.total_users ?? state.users.length);
    $('statTaps').textContent = formatNumber(state.summary?.total_taps ?? 0);
    showMessage($('listMessage'), '');
    renderUsers();
  } catch (error) {
    if (error instanceof SessionError) {
      clearSession();
      showLogin(error.message);
      return;
    }
    showMessage($('listMessage'), error.message || '读取账户失败。');
  }
}

function filteredUsers() {
  const needle = state.filter.trim().toLowerCase();
  if (!needle) return state.users;
  return state.users.filter((u) => {
    const name = String(u.username || '').toLowerCase();
    const title = String(u.title || '').toLowerCase();
    return name.includes(needle) || title.includes(needle);
  });
}

function makeBadge(text, kind = '') {
  const span = document.createElement('span');
  span.className = `badge ${kind}`.trim();
  span.textContent = text;
  return span;
}

function makeCell(label) {
  const td = document.createElement('td');
  td.dataset.label = label;
  return td;
}

function renderUsers() {
  const tbody = $('userRows');
  tbody.replaceChildren();
  const rows = filteredUsers();
  $('emptyState').hidden = rows.length > 0;

  for (const user of rows) {
    const tr = document.createElement('tr');

    // 账户
    const userCell = makeCell('账户');
    const wrap = document.createElement('div');
    wrap.className = 'cell-user';

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = (user.username || '无').slice(0, 1);

    const info = document.createElement('div');
    const nameLine = document.createElement('div');
    nameLine.className = 'user-name';
    const nameText = document.createElement('span');
    nameText.textContent = user.username;
    nameLine.appendChild(nameText);
    if (user.is_admin) nameLine.appendChild(makeBadge('管理员'));
    if (isBanned(user)) nameLine.appendChild(makeBadge('已封禁', 'banned'));

    const sub = document.createElement('div');
    sub.className = 'user-sub mono';
    sub.textContent = user.user_id === state.selfId ? '当前登录账户' : `ID ${String(user.user_id).slice(0, 8)}…`;

    info.append(nameLine, sub);
    wrap.append(avatar, info);
    userCell.appendChild(wrap);

    // 头衔
    const titleCell = makeCell('头衔');
    if (user.title) titleCell.appendChild(makeBadge(user.title, 'title'));
    else titleCell.textContent = '—';

    // 分数
    const totalCell = makeCell('分数');
    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = formatNumber(user.total);
    totalCell.appendChild(score);

    // 注册 / 登录
    const dateCell = makeCell('注册 / 最近登录');
    const dates = document.createElement('div');
    dates.className = 'dates';
    const created = document.createElement('div');
    created.textContent = `注册 ${formatDate(user.created_at)}`;
    const login = document.createElement('div');
    login.textContent = `登录 ${user.last_sign_in_at ? formatDateTime(user.last_sign_in_at) : '从未登录'}`;
    dates.append(created, login);
    dateCell.appendChild(dates);

    // 操作
    const actionCell = makeCell('操作');
    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'ghost';
    edit.dataset.action = 'edit';
    edit.dataset.id = user.user_id;
    edit.textContent = '编辑';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost del';
    del.dataset.action = 'delete';
    del.dataset.id = user.user_id;
    del.textContent = '删除';
    if (user.user_id === state.selfId) {
      del.disabled = true;
      del.title = '不能删除当前登录的管理员账户';
    }

    actions.append(edit, del);
    actionCell.appendChild(actions);

    tr.append(userCell, titleCell, totalCell, dateCell, actionCell);
    tbody.appendChild(tr);
  }
}

/* ---------------- 编辑 ---------------- */

function openEdit(user) {
  state.editUser = user;
  $('editUserId').value = user.user_id;
  $('editUsername').value = user.username || '';
  $('editTitleInput').value = user.title || '';
  $('editTotal').value = String(user.total ?? 0);
  $('editPassword').value = '';
  $('editPassword').type = 'password';
  $('editTogglePassword').textContent = '显示';
  showMessage($('editMessage'), '');
  $('editNote').textContent = `正在编辑「${user.username}」。修改会立即生效。`;
  $('editSubmit').disabled = false;
  $('editSubmit').textContent = '保存';
  $('editDialog').showModal();
  setTimeout(() => $('editUsername').focus(), 30);
}

async function onEditSubmit(event) {
  event.preventDefault();
  const user = state.editUser;
  if (!user) return;

  const username = displayName($('editUsername').value);
  const title = $('editTitleInput').value.trim();
  const totalRaw = $('editTotal').value.trim();
  const password = $('editPassword').value;

  if (!validName(username)) {
    showMessage($('editMessage'), '用户名需为 2 至 24 个汉字、字母、数字、下划线或短横线，不能含空格或点号。');
    return;
  }
  if ([...title].length > 12) {
    showMessage($('editMessage'), '头衔最多 12 个字。');
    return;
  }
  if (!/^\d+$/.test(totalRaw)) {
    showMessage($('editMessage'), '分数必须是不小于 0 的整数。');
    return;
  }
  const total = Number(totalRaw);
  if (!Number.isSafeInteger(total) || total < 0) {
    showMessage($('editMessage'), '分数必须是不小于 0 的整数。');
    return;
  }
  if (password && (password.length < 8 || passwordBytes(password) > 72)) {
    showMessage($('editMessage'), '新密码需为 8 至 72 字节（约 8–24 个汉字）。');
    return;
  }

  const submit = $('editSubmit');
  submit.disabled = true;
  submit.textContent = '保存中…';
  showMessage($('editMessage'), '');

  try {
    const loginEmail = await identityAddress(username);
    await rpc('admin_update_user', {
      p_user_id: user.user_id,
      p_username: username,
      p_login_email: loginEmail,
      p_title: title || null,
      p_total: total,
      p_password: password || null,
    });
    $('editDialog').close();
    toast(`已保存「${username}」的修改。`);
    await loadUsers();
  } catch (error) {
    if (error instanceof SessionError) {
      $('editDialog').close();
      clearSession();
      showLogin(error.message);
      return;
    }
    showMessage($('editMessage'), error.message || '保存失败。');
  } finally {
    submit.disabled = false;
    submit.textContent = '保存';
  }
}

/* ---------------- 新增 ---------------- */

function resetCreateForm() {
  $('createForm').reset();
  $('createPassword').type = 'password';
  $('createTogglePassword').textContent = '显示';
  $('createTotal').value = '0';
  $('createPassword').value = randomPassword();
  $('createSubmit').disabled = false;
  $('createSubmit').textContent = '创建账户';
  showMessage($('createMessage'), '');
}

function openCreate() {
  resetCreateForm();
  $('createDialog').showModal();
  setTimeout(() => $('createUsername').focus(), 30);
}

async function onCreateSubmit(event) {
  event.preventDefault();
  const username = displayName($('createUsername').value);
  const password = $('createPassword').value;
  const title = $('createTitleInput').value.trim();
  const totalRaw = $('createTotal').value.trim();

  if (!validName(username)) {
    showMessage($('createMessage'), '用户名需为 2 至 24 个汉字、字母、数字、下划线或短横线，不能含空格或点号。');
    return;
  }
  if (!password || password.length < 8 || passwordBytes(password) > 72) {
    showMessage($('createMessage'), '初始密码需为 8 至 72 字节。');
    return;
  }
  if ([...title].length > 12) {
    showMessage($('createMessage'), '头衔最多 12 个字。');
    return;
  }
  if (!/^\d+$/.test(totalRaw)) {
    showMessage($('createMessage'), '初始分数必须是不小于 0 的整数。');
    return;
  }
  const total = Number(totalRaw);
  if (!Number.isSafeInteger(total) || total < 0) {
    showMessage($('createMessage'), '初始分数必须是不小于 0 的整数。');
    return;
  }

  const submit = $('createSubmit');
  submit.disabled = true;
  submit.textContent = '创建中…';
  showMessage($('createMessage'), '');

  try {
    const loginEmail = await identityAddress(username);
    await rpc('admin_create_user', {
      p_username: username,
      p_login_email: loginEmail,
      p_password: password,
      p_title: title || null,
      p_total: total,
    });
    submit.textContent = '已创建';
    showMessage(
      $('createMessage'),
      `账户「${username}」已创建。请现在把用户名和上面的密码交给对方；关闭窗口后密码不再显示。`,
      'ok',
    );
    try {
      await navigator.clipboard.writeText(password);
      toast('账户已创建，密码已复制到剪贴板。');
    } catch {
      toast('账户已创建。请手动复制上面的密码。');
    }
    await loadUsers();
  } catch (error) {
    submit.disabled = false;
    submit.textContent = '创建账户';
    if (error instanceof SessionError) {
      $('createDialog').close();
      clearSession();
      showLogin(error.message);
      return;
    }
    showMessage($('createMessage'), error.message || '创建失败。');
  }
}

/* ---------------- 删除 ---------------- */

function openDelete(user) {
  if (user.user_id === state.selfId) {
    toast('不能删除当前登录的管理员账户。', 'error');
    return;
  }
  state.deleteUser = user;
  $('deleteUserId').value = user.user_id;
  $('deleteName').textContent = user.username;
  $('deleteTotal').textContent = formatNumber(user.total);
  $('deleteConfirmInput').value = '';
  $('deleteSubmit').disabled = false;
  $('deleteSubmit').textContent = '永久删除';
  showMessage($('deleteMessage'), '');
  $('deleteDialog').showModal();
  setTimeout(() => $('deleteConfirmInput').focus(), 30);
}

async function onDeleteSubmit(event) {
  event.preventDefault();
  const user = state.deleteUser;
  if (!user) return;

  if ($('deleteConfirmInput').value !== user.username) {
    showMessage($('deleteMessage'), '请输入完整、完全一致的用户名再确认。');
    return;
  }

  const submit = $('deleteSubmit');
  submit.disabled = true;
  submit.textContent = '删除中…';

  try {
    await rpc('admin_delete_user', { p_user_id: user.user_id });
    $('deleteDialog').close();
    toast(`已删除账户「${user.username}」。`);
    await loadUsers();
  } catch (error) {
    submit.disabled = false;
    submit.textContent = '永久删除';
    if (error instanceof SessionError) {
      $('deleteDialog').close();
      clearSession();
      showLogin(error.message);
      return;
    }
    showMessage($('deleteMessage'), error.message || '删除失败。');
  }
}

/* ---------------- 事件绑定 ---------------- */

function bindDialogClose(dialog) {
  dialog.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => dialog.close());
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

function bindEvents() {
  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('loginSubmit');
    const username = $('loginName').value;
    const password = $('loginPassword').value;
    if (!username || !password) {
      showMessage($('loginMessage'), '请输入用户名和密码。');
      return;
    }
    submit.disabled = true;
    submit.textContent = '登录中…';
    showMessage($('loginMessage'), '');
    try {
      await signInWithPassword(username, password);
      $('loginPassword').value = '';
      await enterConsole();
    } catch (error) {
      showMessage($('loginMessage'), error.message || '登录失败。');
    } finally {
      submit.disabled = false;
      submit.textContent = '登录管理台';
    }
  });

  $('adoptSiteSession').addEventListener('click', async () => {
    const button = $('adoptSiteSession');
    button.disabled = true;
    showMessage($('loginMessage'), '');
    try {
      await adoptSiteLogin();
      await enterConsole();
    } catch (error) {
      showMessage($('loginMessage'), error.message || '无法使用主站登录状态。');
    } finally {
      button.disabled = false;
    }
  });

  $('signOutButton').addEventListener('click', () => {
    clearSession();
    skipAdopt();
    showLogin('已退出管理台。主站的登录状态不受影响。');
  });

  $('searchInput').addEventListener('input', (event) => {
    const value = event.target.value;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.filter = value;
      renderUsers();
    }, 120);
  });

  $('reloadButton').addEventListener('click', () => loadUsers());
  $('createButton').addEventListener('click', openCreate);

  $('userRows').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const user = state.users.find((item) => item.user_id === button.dataset.id);
    if (!user) return;
    if (button.dataset.action === 'edit') openEdit(user);
    if (button.dataset.action === 'delete') openDelete(user);
  });

  $('editForm').addEventListener('submit', onEditSubmit);
  $('createForm').addEventListener('submit', onCreateSubmit);
  $('deleteForm').addEventListener('submit', onDeleteSubmit);

  $('editGeneratePassword').addEventListener('click', () => {
    $('editPassword').value = randomPassword();
    $('editPassword').type = 'text';
    $('editTogglePassword').textContent = '隐藏';
  });

  $('createGeneratePassword').addEventListener('click', () => {
    $('createPassword').value = randomPassword();
    $('createPassword').type = 'text';
    $('createTogglePassword').textContent = '隐藏';
  });

  $('editTogglePassword').addEventListener('click', () => {
    const input = $('editPassword');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('editTogglePassword').textContent = show ? '隐藏' : '显示';
  });

  $('createTogglePassword').addEventListener('click', () => {
    const input = $('createPassword');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('createTogglePassword').textContent = show ? '隐藏' : '显示';
  });

  $('createDialog').addEventListener('close', () => {
    resetCreateForm();
  });

  [$('editDialog'), $('createDialog'), $('deleteDialog')].forEach(bindDialogClose);

  window.addEventListener('storage', (event) => {
    if (event.key === CONFIG.siteSessionKey) updateAdoptVisibility();
  });

  window.addEventListener('focus', () => {
    if (!$('loginPanel').hidden) updateAdoptVisibility();
  });
}

/* ---------------- 启动 ---------------- */

async function init() {
  bindEvents();
  updateAdoptVisibility();

  const stored = readJsonStorage(CONFIG.adminSessionKey);
  const hasToken = stored && stored.access_token;

  if (hasToken) {
    state.session = {
      access_token: stored.access_token,
      refresh_token: stored.refresh_token || null,
      expires_at: Number(stored.expires_at) || null,
      user: stored.user || null,
      source: stored.source === 'site' ? 'site' : 'own',
    };
    state.selfId = stored.user?.id || jwtSub(stored.access_token);
    try {
      await assertAdmin();
      await enterConsole();
      return;
    } catch (error) {
      clearSession();
      if (error instanceof SessionError) {
        showLogin('登录状态已过期，请重新登录。');
        return;
      }
      showLogin(error.message || '需要管理员权限。');
      return;
    }
  }

  if (!isAdoptSkipped()) {
    const site = siteSession();
    if (site) {
      state.session = site;
      state.selfId = site.user?.id || jwtSub(site.access_token);
      try {
        await assertAdmin();
        persistSession(site);
        await enterConsole();
        return;
      } catch {
        clearSession();
        showLogin('主站当前登录的账号不是管理员，请用管理员账号登录。');
        return;
      }
    }
  }

  showLogin();
}

init();
