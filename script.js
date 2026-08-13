const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const POINTS_PER_LEVEL = 20;
const STAR_LEVEL = 25;
const SESSION_KEY = 'sqlvault_session_token';

let currentUser = null; // { id, email, username, isAdmin, points, level } or null when signed out
let sessionToken = null;

function canModify(script) {
  if (!currentUser) return false;
  return currentUser.id === script.user_id || currentUser.isAdmin;
}

const TYPES = [
  { id: 'Schema', color: '#4FBDBA' },
  { id: 'Query', color: '#E8A33D' },
  { id: 'Impact', color: '#B48EF0' },
  { id: 'Script', color: '#6FCF97' },
  { id: 'Other', color: '#8B96A5' },
];

const COMPLEXITY_POINTS = { Small: 5, Medium: 10, Big: 15 };

function detectComplexity(sql) {
  const text = (sql || '').trim();
  if (!text) return 'Small';

  const upper = text.toUpperCase();
  const lines = text.split('\n').filter(l => l.trim().length > 0).length;
  const length = text.length;
  let score = 0;

  if (length > 600) score += 2;
  else if (length > 200) score += 1;

  if (lines > 25) score += 2;
  else if (lines > 8) score += 1;

  const joinCount = (upper.match(/\bJOIN\b/g) || []).length;
  if (joinCount >= 2) score += 3;
  else if (joinCount === 1) score += 2;

  const subqueryCount = (upper.match(/\(\s*SELECT\b/g) || []).length;
  if (subqueryCount > 0) score += 2;

  if (/\bWITH\b[\s\S]*\bAS\s*\(/.test(upper)) score += 1;

  if (/\bGROUP BY\b/.test(upper)) score += 1;
  if (/\bHAVING\b/.test(upper)) score += 1;
  if (/\bUNION\b/.test(upper)) score += 1;
  if (/\bOVER\s*\(/.test(upper)) score += 2;

  const stmtCount = (text.match(/;/g) || []).length;
  if (stmtCount > 3) score += 1;

  if (score >= 5) return 'Big';
  if (score >= 2) return 'Medium';
  return 'Small';
}

function updateComplexityDisplay() {
  const type = document.getElementById('fieldType').value;
  const content = document.getElementById('fieldContent').value;
  const el = document.getElementById('complexityDisplay');

  if (type === 'Other') {
    el.textContent = 'Other — 0 pts (does not earn points)';
    el.className = 'complexity-display other';
    return 'Other';
  }

  const level = detectComplexity(content);
  const pts = COMPLEXITY_POINTS[level];
  el.textContent = `${level} — ${pts} pts`;
  el.className = 'complexity-display ' + level.toLowerCase();
  return level;
}

let scripts = [];
let query = '';
let projectFilter = null;
let typeFilter = null;
const openIds = new Set();
let editingId = null;

// ---------- Persistence (Supabase) ----------

async function loadScripts() {
  const { data, error } = await sb
    .from('scripts')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to load scripts:', error);
    alert('Could not load scripts from Supabase. Check your URL/key in supabase.js and your internet connection.');
    scripts = [];
    return;
  }
  scripts = data.map(row => ({
    id: row.id,
    title: row.title,
    project: row.project,
    type: row.type,
    tags: row.tags || [],
    content: row.content,
    complexity: row.complexity || 'Medium',
    createdAt: new Date(row.created_at).getTime(),
    user_id: row.user_id,
    created_by: row.created_by || 'Unknown',
  }));
}

async function insertScript(script) {
  if (!currentUser || !sessionToken) {
    alert('You need to sign in to add a script.');
    return null;
  }
  const { data, error } = await sb.rpc('custom_insert_script', {
    p_session_token: sessionToken,
    p_title: script.title,
    p_project: script.project,
    p_type: script.type,
    p_tags: script.tags,
    p_content: script.content,
    p_complexity: script.complexity,
  });

  if (error) {
    console.error('Failed to save script:', error);
    alert('Could not save this script: ' + error.message);
    return null;
  }
  const row = data;
  return {
    id: row.id,
    title: row.title,
    project: row.project,
    type: row.type,
    tags: row.tags || [],
    content: row.content,
    complexity: row.complexity || 'Medium',
    createdAt: new Date(row.created_at).getTime(),
    user_id: row.user_id,
    created_by: row.created_by,
  };
}

async function updateScriptRow(id, fields) {
  if (!sessionToken) {
    alert('You need to sign in to edit a script.');
    return false;
  }
  const { error } = await sb.rpc('custom_update_script', {
    p_session_token: sessionToken,
    p_id: id,
    p_title: fields.title,
    p_project: fields.project,
    p_type: fields.type,
    p_tags: fields.tags,
    p_content: fields.content,
    p_complexity: fields.complexity,
  });

  if (error) {
    console.error('Failed to update script:', error);
    alert('Could not save your changes: ' + error.message);
    return false;
  }
  return true;
}

async function deleteScriptRow(id) {
  if (!sessionToken) {
    alert('You need to sign in to delete a script.');
    return false;
  }
  const { error } = await sb.rpc('custom_delete_script', {
    p_session_token: sessionToken,
    p_id: id,
  });

  if (error) {
    console.error('Failed to delete script:', error);
    alert('Could not delete this script: ' + error.message);
    return false;
  }
  return true;
}

function typeColor(t) {
  const found = TYPES.find(x => x.id === t);
  return found ? found.color : '#8B96A5';
}

// ---------- Derived data ----------

function getProjects() {
  const map = {};
  scripts.forEach(s => { map[s.project] = (map[s.project] || 0) + 1; });
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

function getTypeCounts() {
  const map = {};
  scripts.forEach(s => { map[s.type] = (map[s.type] || 0) + 1; });
  return map;
}

function getFiltered() {
  const q = query.trim().toLowerCase();
  return scripts.filter(s => {
    if (projectFilter && s.project !== projectFilter) return false;
    if (typeFilter && s.type !== typeFilter) return false;
    if (!q) return true;
    const hay = (s.title + ' ' + s.content + ' ' + s.tags.join(' ') + ' ' + s.project).toLowerCase();
    return hay.includes(q);
  }).sort((a, b) => b.createdAt - a.createdAt);
}

// ---------- Rendering ----------

function render() {
  renderSidebar();
  renderScriptList();
  document.getElementById('scriptCountLabel').textContent =
    `${scripts.length} script${scripts.length !== 1 ? 's' : ''} stored`;
}

function renderSidebar() {
  const projects = getProjects();
  const typeCounts = getTypeCounts();

  const projList = document.getElementById('projectFilterList');
  projList.innerHTML = '';
  projList.appendChild(makeFilterItem('All projects', scripts.length, !projectFilter, () => {
    projectFilter = null; render();
  }));
  projects.forEach(([name, count]) => {
    projList.appendChild(makeFilterItem(name, count, projectFilter === name, () => {
      projectFilter = name; render();
    }));
  });

  const typeList = document.getElementById('typeFilterList');
  typeList.innerHTML = '';
  typeList.appendChild(makeFilterItem('All types', scripts.length, !typeFilter, () => {
    typeFilter = null; render();
  }));
  TYPES.forEach(t => {
    const item = makeFilterItem(t.id, typeCounts[t.id] || 0, typeFilter === t.id, () => {
      typeFilter = t.id; render();
    });
    const swatch = document.createElement('span');
    swatch.className = 'type-swatch';
    swatch.style.background = t.color;
    item.querySelector('span').prepend(swatch);
    typeList.appendChild(item);
  });

  const datalist = document.getElementById('projectOptions');
  datalist.innerHTML = '';
  projects.forEach(([name]) => {
    const opt = document.createElement('option');
    opt.value = name;
    datalist.appendChild(opt);
  });
}

function makeFilterItem(label, count, active, onClick) {
  const div = document.createElement('div');
  div.className = 'filter-item' + (active ? ' active' : '');
  div.innerHTML = `<span>${escapeHtml(label)}</span><span class="count">${count}</span>`;
  div.addEventListener('click', onClick);
  return div;
}

function renderScriptList() {
  const filtered = getFiltered();
  const listEl = document.getElementById('scriptList');
  const emptyEl = document.getElementById('emptyState');

  if (filtered.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    document.getElementById('emptyGlyph').textContent = scripts.length === 0 ? '{ }' : '∅';
    document.getElementById('emptyMsg').textContent = scripts.length === 0
      ? 'No scripts yet. Add your first one.'
      : 'Nothing matches your search or filters.';
    document.getElementById('emptyNewBtn').style.display = scripts.length === 0 ? 'inline-block' : 'none';
    return;
  }

  emptyEl.style.display = 'none';
  listEl.innerHTML = '';

  filtered.forEach((s, i) => {
    const isOpen = openIds.has(s.id);
    const card = document.createElement('div');
    card.className = 'script-card' + (isOpen ? ' open' : '');

    const tagsHtml = s.tags.slice(0, 3).map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('');
    const allowed = canModify(s);

    card.innerHTML = `
      <div class="script-row">
        <div class="script-stripe" style="background:${typeColor(s.type)}"></div>
        <div class="script-index">${String(i + 1).padStart(4, '0')}</div>
        <div class="script-meta">
          <div class="script-title">${escapeHtml(s.title)}</div>
          <div class="script-sub">
            <span class="pill" style="background:${typeColor(s.type)}">${escapeHtml(s.type)}</span>
            <span class="proj-tag">${escapeHtml(s.project)}</span>
            ${tagsHtml}
            <span class="created-by">added by ${escapeHtml(s.created_by || 'Unknown')} · ${escapeHtml(s.complexity)} (${COMPLEXITY_POINTS[s.complexity] || 10} pts)</span>
          </div>
        </div>
        <svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </div>
      <div class="script-body">
        <div class="code-block"></div>
        <div class="body-actions">
          ${allowed ? '<button class="icon-btn danger" data-action="delete">Delete</button>' : ''}
          ${allowed ? '<button class="icon-btn" data-action="edit">Edit</button>' : ''}
          <button class="icon-btn" data-action="copy">Copy</button>
        </div>
      </div>
    `;

    card.querySelector('.code-block').textContent = s.content;

    card.querySelector('.script-row').addEventListener('click', () => {
      openIds.has(s.id) ? openIds.delete(s.id) : openIds.add(s.id);
      renderScriptList();
    });

    const deleteBtn = card.querySelector('[data-action="delete"]');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm('Delete this script? This cannot be undone. Note: this will also remove the points it earned.')) {
          const ok = await deleteScriptRow(s.id);
          if (ok) {
            scripts = scripts.filter(x => x.id !== s.id);
            await refreshMyProfile();
            render();
          }
        }
      });
    }

    const editBtn = card.querySelector('[data-action="edit"]');
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(s);
      });
    }

    card.querySelector('[data-action="copy"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      navigator.clipboard.writeText(s.content).then(() => {
        const original = btn.textContent;
        btn.textContent = '✓ Copied';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1400);
      });
    });

    listEl.appendChild(card);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Modal ----------

function openModal(script) {
  editingId = script ? script.id : null;
  document.getElementById('modalTitle').textContent = script ? 'Edit script' : 'New script';
  document.getElementById('fieldTitle').value = script ? script.title : '';
  document.getElementById('fieldProject').value = script ? script.project : (getProjects()[0]?.[0] || '');
  document.getElementById('fieldType').value = script ? script.type : 'Query';
  document.getElementById('fieldTags').value = script ? script.tags.join(', ') : '';
  document.getElementById('fieldContent').value = script ? script.content : '';
  updateComplexityDisplay();
  document.getElementById('modalBackdrop').classList.add('show');
  document.getElementById('fieldTitle').focus();
}

document.getElementById('fieldContent').addEventListener('input', updateComplexityDisplay);
document.getElementById('fieldType').addEventListener('change', updateComplexityDisplay);

function closeModal() {
  document.getElementById('modalBackdrop').classList.remove('show');
  editingId = null;
}

async function saveFromModal() {
  const title = document.getElementById('fieldTitle').value.trim();
  const project = document.getElementById('fieldProject').value.trim() || 'General';
  const type = document.getElementById('fieldType').value;
  const tags = document.getElementById('fieldTags').value.split(',').map(t => t.trim()).filter(Boolean);
  const content = document.getElementById('fieldContent').value;
  const complexity = type === 'Other' ? 'Other' : detectComplexity(content);

  if (!title || !content.trim()) {
    alert('Please fill in at least a title and the SQL content.');
    return;
  }

  const saveBtn = document.getElementById('saveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  if (editingId) {
    const ok = await updateScriptRow(editingId, { title, project, type, complexity, tags, content });
    if (ok) {
      scripts = scripts.map(s => s.id === editingId
        ? { ...s, title, project, type, complexity, tags, content }
        : s);
    }
  } else {
    const newScript = await insertScript({ title, project, type, complexity, tags, content });
    if (newScript) {
      scripts.push(newScript);
      await refreshMyProfile();
    }
  }

  saveBtn.disabled = false;
  saveBtn.textContent = 'Save script';
  closeModal();
  render();
}

// ---------- Event wiring ----------

document.getElementById('searchInput').addEventListener('input', (e) => {
  query = e.target.value;
  renderScriptList();
});

document.getElementById('newScriptBtn').addEventListener('click', () => {
  if (!currentUser) { openAuthModal('signin'); return; }
  openModal(null);
});
document.getElementById('emptyNewBtn').addEventListener('click', () => {
  if (!currentUser) { openAuthModal('signin'); return; }
  openModal(null);
});
document.getElementById('cancelBtn').addEventListener('click', closeModal);
document.getElementById('saveBtn').addEventListener('click', saveFromModal);

document.getElementById('modalBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modalBackdrop') closeModal();
});

// ---------- Auth (custom SQL-based, no Supabase Auth) ----------

let authMode = 'signin'; // 'signin' | 'signup'

function levelProgress(points) {
  const level = Math.floor(points / POINTS_PER_LEVEL) + 1;
  const intoLevel = points % POINTS_PER_LEVEL;
  const pct = Math.round((intoLevel / POINTS_PER_LEVEL) * 100);
  return { level, pct };
}

function renderAuthWidget() {
  const el = document.getElementById('authWidget');
  if (currentUser) {
    const { level, pct } = levelProgress(currentUser.points);
    const star = level >= STAR_LEVEL ? '<span class="star-badge">★</span>' : '';
    el.innerHTML = `
      <div class="auth-signed-in">
        <div class="name">${escapeHtml(currentUser.username)} ${star}</div>
        <div class="level-row"><span>Level ${level}</span><span>${currentUser.points} pts</span></div>
        <div class="level-bar-track"><div class="level-bar-fill" style="width:${pct}%"></div></div>
      </div>
      <button class="btn btn-ghost" id="signOutBtn">Sign out</button>
    `;
    document.getElementById('signOutBtn').addEventListener('click', signOut);
  } else {
    el.innerHTML = `<button class="btn btn-primary" id="signInBtn">Sign in / Sign up</button>`;
    document.getElementById('signInBtn').addEventListener('click', () => openAuthModal('signin'));
  }
}

function openAuthModal(mode) {
  authMode = mode;
  document.getElementById('authEmail').value = '';
  document.getElementById('authPassword').value = '';
  document.getElementById('authUsername').value = '';
  document.getElementById('authError').textContent = '';
  document.getElementById('authSuccess').textContent = '';
  updateAuthTabs();
  document.getElementById('authModalBackdrop').classList.add('show');
}

function closeAuthModal() {
  document.getElementById('authModalBackdrop').classList.remove('show');
}

function updateAuthTabs() {
  const isSignUp = authMode === 'signup';

  document.getElementById('authTabsRow').style.display = 'flex';
  document.getElementById('authTitleForReset').style.display = 'none';
  document.getElementById('tabSignIn').classList.toggle('active', !isSignUp);
  document.getElementById('tabSignUp').classList.toggle('active', isSignUp);
  document.getElementById('usernameField').style.display = isSignUp ? 'block' : 'none';
  document.getElementById('passwordField').style.display = 'block';
  document.getElementById('forgotLinkRow').style.display = (authMode === 'signin') ? 'block' : 'none';

  document.getElementById('authSubmitBtn').textContent = isSignUp ? 'Create account' : 'Sign in';
}

document.getElementById('tabSignIn').addEventListener('click', () => { authMode = 'signin'; updateAuthTabs(); });
document.getElementById('tabSignUp').addEventListener('click', () => { authMode = 'signup'; updateAuthTabs(); });
document.getElementById('authCancelBtn').addEventListener('click', closeAuthModal);
document.getElementById('authModalBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'authModalBackdrop') closeAuthModal();
});

// NOTE: no click listener on forgotPasswordLink anymore —
// it's a plain <a href="reset.html"> now and navigates normally.

document.getElementById('authSubmitBtn').addEventListener('click', async () => {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const username = document.getElementById('authUsername').value.trim();
  const errorEl = document.getElementById('authError');
  const successEl = document.getElementById('authSuccess');
  errorEl.textContent = '';
  successEl.textContent = '';

  if (!email || !password) {
    errorEl.textContent = 'Please fill in email and password.';
    return;
  }
  if (authMode === 'signup' && !username) {
    errorEl.textContent = 'Please choose a display name.';
    return;
  }

  const btn = document.getElementById('authSubmitBtn');
  btn.disabled = true;

  if (authMode === 'signup') {
    const { error } = await sb.rpc('custom_signup', {
      p_email: email, p_username: username, p_password: password,
    });
    btn.disabled = false;
    if (error) { errorEl.textContent = error.message; return; }

    const { data: loginData, error: loginError } = await sb.rpc('custom_login', {
      p_email: email, p_password: password,
    });
    if (loginError) { errorEl.textContent = loginError.message; return; }
    applySession(loginData);
    closeAuthModal();
  } else {
    const { data, error } = await sb.rpc('custom_login', {
      p_email: email, p_password: password,
    });
    btn.disabled = false;
    if (error) { errorEl.textContent = error.message; return; }
    applySession(data);
    closeAuthModal();
  }
});

function applySession(data) {
  localStorage.setItem(SESSION_KEY, data.session_token);
  sessionToken = data.session_token;
  currentUser = {
    id: data.id,
    username: data.username,
    isAdmin: data.is_admin,
    points: data.points,
    level: data.level,
  };
  renderAuthWidget();
  render();
}

async function signOut() {
  const token = localStorage.getItem(SESSION_KEY);
  if (token) {
    await sb.rpc('custom_logout', { p_token: token });
  }
  localStorage.removeItem(SESSION_KEY);
  sessionToken = null;
  currentUser = null;
  renderAuthWidget();
  render();
}

async function restoreSession() {
  const token = localStorage.getItem(SESSION_KEY);
  if (!token) {
    currentUser = null;
    return;
  }
  const { data, error } = await sb.rpc('custom_get_session', { p_token: token });
  if (error || !data) {
    localStorage.removeItem(SESSION_KEY);
    sessionToken = null;
    currentUser = null;
    return;
  }
  sessionToken = token;
  currentUser = {
    id: data.id,
    username: data.username,
    isAdmin: data.is_admin,
    points: data.points,
    level: data.level,
  };
}

async function refreshMyProfile() {
  if (!currentUser) return;
  const { data: profile } = await sb
    .from('profiles_public')
    .select('points, level, is_admin')
    .eq('id', currentUser.id)
    .single();
  if (profile) {
    currentUser.points = profile.points;
    currentUser.level = profile.level;
    currentUser.isAdmin = profile.is_admin;
  }
  renderAuthWidget();
}

// ---------- Leaderboard ----------

document.getElementById('leaderboardBtn').addEventListener('click', openLeaderboard);
document.getElementById('leaderboardCloseBtn').addEventListener('click', closeLeaderboard);
document.getElementById('leaderboardModalBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'leaderboardModalBackdrop') closeLeaderboard();
});

async function openLeaderboard() {
  document.getElementById('leaderboardModalBackdrop').classList.add('show');
  const listEl = document.getElementById('leaderboardList');
  listEl.innerHTML = '<div style="color:var(--text-faint); font-size:12px;">Loading…</div>';

  const { data, error } = await sb
    .from('profiles_public')
    .select('username, points, level')
    .order('points', { ascending: false })
    .limit(50);

  if (error) {
    listEl.innerHTML = '<div style="color:var(--danger); font-size:12px;">Could not load leaderboard.</div>';
    return;
  }

  listEl.innerHTML = '';
  data.forEach((p, i) => {
    const rank = i + 1;
    const row = document.createElement('div');
    row.className = 'leaderboard-row' + (rank <= 3 ? ` rank-${rank}` : '');
    const star = p.level >= STAR_LEVEL ? '<span class="star-badge">★</span>' : '';
    row.innerHTML = `
      <div class="leaderboard-rank">#${rank}</div>
      <div class="leaderboard-meta">
        <div class="leaderboard-name">${escapeHtml(p.username)} ${star}</div>
        <div class="leaderboard-sub">Level ${p.level}</div>
      </div>
      <div class="leaderboard-points">${p.points} pts</div>
    `;
    listEl.appendChild(row);
  });

  if (data.length === 0) {
    listEl.innerHTML = '<div style="color:var(--text-faint); font-size:12px;">No profiles yet.</div>';
  }
}

function closeLeaderboard() {
  document.getElementById('leaderboardModalBackdrop').classList.remove('show');
}

// ---------- Init ----------

async function init() {
  document.getElementById('scriptCountLabel').textContent = 'Loading…';
  await restoreSession();
  renderAuthWidget();
  await loadScripts();
  render();
}

init();
