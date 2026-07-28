const STORAGE_KEY = 'sql-vault-scripts';

const TYPES = [
  { id: 'Schema', color: '#4FBDBA' },
  { id: 'Query', color: '#E8A33D' },
  { id: 'Impact', color: '#B48EF0' },
  { id: 'Scripts', color: '#6FCF97' },
  { id: 'Other', color: '#8B96A5' },
];

let scripts = [];
let query = '';
let projectFilter = null;
let typeFilter = null;
const openIds = new Set();
let editingId = null; // null = not editing, 'new' = creating

// ---------- Persistence ----------

function loadScripts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    scripts = raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load scripts:', e);
    scripts = [];
  }
}

function saveScripts() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scripts));
  } catch (e) {
    console.error('Failed to save scripts:', e);
    alert('Could not save your changes. Your browser storage may be full or disabled.');
  }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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

  // refresh project datalist for the modal
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
          </div>
        </div>
        <svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </div>
      <div class="script-body">
        <div class="code-block"></div>
        <div class="body-actions">
          <button class="icon-btn danger" data-action="delete">Delete</button>
          <button class="icon-btn" data-action="edit">Edit</button>
          <button class="icon-btn" data-action="copy">Copy</button>
        </div>
      </div>
    `;

    // set code content via textContent to avoid HTML injection issues
    card.querySelector('.code-block').textContent = s.content;

    card.querySelector('.script-row').addEventListener('click', () => {
      openIds.has(s.id) ? openIds.delete(s.id) : openIds.add(s.id);
      renderScriptList();
    });

    card.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Delete this script? This cannot be undone.')) {
        scripts = scripts.filter(x => x.id !== s.id);
        saveScripts();
        render();
      }
    });

    card.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openModal(s);
    });

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
  document.getElementById('modalBackdrop').classList.add('show');
  document.getElementById('fieldTitle').focus();
}

function closeModal() {
  document.getElementById('modalBackdrop').classList.remove('show');
  editingId = null;
}

function saveFromModal() {
  const title = document.getElementById('fieldTitle').value.trim();
  const project = document.getElementById('fieldProject').value.trim() || 'General';
  const type = document.getElementById('fieldType').value;
  const tags = document.getElementById('fieldTags').value.split(',').map(t => t.trim()).filter(Boolean);
  const content = document.getElementById('fieldContent').value;

  if (!title || !content.trim()) {
    alert('Please fill in at least a title and the SQL content.');
    return;
  }

  if (editingId) {
    scripts = scripts.map(s => s.id === editingId
      ? { ...s, title, project, type, tags, content }
      : s);
  } else {
    scripts.push({
      id: uid(),
      title, project, type, tags, content,
      createdAt: Date.now(),
    });
  }

  saveScripts();
  closeModal();
  render();
}

// ---------- Event wiring ----------

document.getElementById('searchInput').addEventListener('input', (e) => {
  query = e.target.value;
  renderScriptList();
});

document.getElementById('newScriptBtn').addEventListener('click', () => openModal(null));
document.getElementById('emptyNewBtn').addEventListener('click', () => openModal(null));
document.getElementById('cancelBtn').addEventListener('click', closeModal);
document.getElementById('saveBtn').addEventListener('click', saveFromModal);

document.getElementById('modalBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modalBackdrop') closeModal();
});

// ---------- Init ----------

loadScripts();
render();