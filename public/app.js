const statsGrid = document.getElementById('stats-grid');
const leadList = document.getElementById('lead-list');
const taskList = document.getElementById('task-list');
const leadDetailPanel = document.getElementById('lead-detail-panel');
const leadForm = document.getElementById('lead-form');
const taskForm = document.getElementById('task-form');
const taskLeadSelect = document.getElementById('task-lead-select');
const filterName = document.getElementById('filter-name');
const filterCompany = document.getElementById('filter-company');
const filterStatus = document.getElementById('filter-status');
const leadCancelBtn = document.getElementById('lead-cancel-btn');
const taskCancelBtn = document.getElementById('task-cancel-btn');

const authScreen = document.getElementById('auth-screen');
const appShell = document.getElementById('app-shell');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginTab = document.getElementById('login-tab');
const registerTab = document.getElementById('register-tab');
const authError = document.getElementById('auth-error');
const currentUserLabel = document.getElementById('current-user');
const logoutBtn = document.getElementById('logout-btn');

const statusOrder = ['New', 'Contacted', 'Qualified', 'Won', 'Lost'];
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
let editingLeadId = null;
let editingTaskId = null;
let csrfToken = null;

class AuthRequiredError extends Error {}

function setLoadingState() {
  statsGrid.innerHTML = [1, 2, 3, 4, 5, 6]
    .map(
      () => `
        <article class="stat-card stat-skeleton" aria-hidden="true">
          <span class="label">Loading</span>
          <span class="value">--</span>
        </article>
      `
    )
    .join('');

  leadList.innerHTML = '<div class="empty-state">Loading leads...</div>';
  taskList.innerHTML = '<div class="empty-state">Loading tasks...</div>';
}

async function loadCsrfToken() {
  const response = await fetch('/api/csrf-token', { credentials: 'same-origin' });
  const data = await response.json();
  csrfToken = data.csrfToken;
  return csrfToken;
}

async function fetchJson(url, options = {}, { retryOnCsrf = true } = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };

  if (!SAFE_METHODS.includes(method)) {
    if (!csrfToken) {
      await loadCsrfToken();
    }
    headers['X-CSRF-Token'] = csrfToken;
  }

  const response = await fetch(url, {
    ...options,
    method,
    headers,
    credentials: 'same-origin'
  });

  let data = {};
  try {
    data = await response.json();
  } catch (parseError) {
    data = {};
  }

  if (response.status === 401) {
    showAuthScreen();
    throw new AuthRequiredError(data.message || 'Please sign in again.');
  }

  // The session's token can change (for example after the server restarts);
  // fetch a fresh one and retry once before giving up.
  if (response.status === 403 && /CSRF/i.test(data.message || '') && retryOnCsrf) {
    await loadCsrfToken();
    return fetchJson(url, options, { retryOnCsrf: false });
  }

  if (!response.ok) {
    throw new Error(data.message || 'Request failed.');
  }

  return data;
}

function showError(error) {
  if (error instanceof AuthRequiredError) {
    return;
  }
  alert(error.message);
}

function showAuthScreen() {
  csrfToken = null;
  appShell.hidden = true;
  authScreen.hidden = false;
}

function showAppShell(user) {
  currentUserLabel.textContent = user ? `${user.name} · ${user.email}` : '';
  authScreen.hidden = true;
  appShell.hidden = false;
  authError.hidden = true;
}

function setAuthMode(mode) {
  const isLogin = mode === 'login';
  loginForm.hidden = !isLogin;
  registerForm.hidden = isLogin;
  loginTab.classList.toggle('active', isLogin);
  registerTab.classList.toggle('active', !isLogin);
  loginTab.setAttribute('aria-selected', String(isLogin));
  registerTab.setAttribute('aria-selected', String(!isLogin));
  authError.hidden = true;
}

async function submitAuth(form, url) {
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  authError.hidden = true;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.message || 'Something went wrong. Please try again.');
    }

    csrfToken = data.csrfToken;
    form.reset();
    showAppShell(data.user);
    clearLeadForm();
    clearTaskForm();
    await refreshDashboard();
  } catch (error) {
    authError.textContent = error.message;
    authError.hidden = false;
  } finally {
    submitButton.disabled = false;
  }
}

async function boot() {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!response.ok) {
      showAuthScreen();
      return;
    }

    const { user } = await response.json();
    await loadCsrfToken();
    showAppShell(user);
    clearLeadForm();
    clearTaskForm();
    await refreshDashboard();
  } catch (error) {
    console.error(error);
    showAuthScreen();
  }
}

function renderStats(stats) {
  const cards = [
    { label: 'Total Leads', value: stats.totalLeads || 0 },
    { label: 'New Leads', value: stats.newLeads || 0 },
    { label: 'Active Leads', value: stats.activeLeads || 0 },
    { label: 'Won Leads', value: stats.wonLeads || 0 },
    { label: 'Pending Follow-ups', value: stats.pendingFollowUps || 0 },
    { label: 'Overdue Tasks', value: stats.overdueTasks || 0 }
  ];

  statsGrid.innerHTML = cards
    .map(
      (card) => `
        <article class="stat-card">
          <span class="label">${card.label}</span>
          <span class="value">${card.value}</span>
        </article>
      `
    )
    .join('');
}

function renderLeadDetails(lead) {
  if (!lead) {
    leadDetailPanel.innerHTML = 'Select a lead to review contact details and workflow history.';
    return;
  }

  leadDetailPanel.innerHTML = `
    <div class="detail-header">
      <div>
        <p class="detail-label">Lead detail</p>
        <h4>${escapeHtml(lead.name)}</h4>
      </div>
      <span class="status-pill status-${escapeHtml(lead.status)}">${escapeHtml(lead.status)}</span>
    </div>
    <div class="detail-grid">
      <div><strong>Company:</strong> ${escapeHtml(lead.company || 'Not provided')}</div>
      <div><strong>Source:</strong> ${escapeHtml(lead.source || 'Not provided')}</div>
      <div><strong>Email:</strong> ${escapeHtml(lead.email || 'Not provided')}</div>
      <div><strong>Phone:</strong> ${escapeHtml(lead.phone || 'Not provided')}</div>
      <div class="detail-notes"><strong>Notes:</strong> ${escapeHtml(lead.notes || 'No notes recorded.')}</div>
    </div>
  `;
}

function renderLeads(leads) {
  if (!leads.length) {
    leadDetailPanel.innerHTML = 'Select a lead to review contact details and workflow history.';
    leadList.innerHTML = '<div class="empty-state">No leads match your search.</div>';
    return;
  }

  leadList.innerHTML = leads
    .map(
      (lead) => `
        <article class="list-item">
          <div class="item-header">
            <h4>${escapeHtml(lead.name)}</h4>
            <span class="status-pill status-${escapeHtml(lead.status)}">${escapeHtml(lead.status)}</span>
          </div>
          <div class="item-meta">${escapeHtml(lead.company)} • ${escapeHtml(lead.source)}</div>
          <div class="item-details">
            ${lead.email ? `<div>Email: ${escapeHtml(lead.email)}</div>` : ''}
            ${lead.phone ? `<div>Phone: ${escapeHtml(lead.phone)}</div>` : ''}
            ${lead.notes ? `<div>Notes: ${escapeHtml(lead.notes)}</div>` : ''}
          </div>
          <div class="item-actions">
            <button class="action-btn secondary" data-action="view-lead" data-id="${lead.id}">View details</button>
            <button class="action-btn secondary" data-action="edit-lead" data-id="${lead.id}">Edit</button>
            <button class="action-btn" data-action="update-status" data-id="${lead.id}">Update status</button>
            <button class="delete-btn" data-action="delete-lead" data-id="${lead.id}">Delete</button>
          </div>
        </article>
      `
    )
    .join('');

  leadList.querySelectorAll('[data-action="view-lead"]').forEach((button) => {
    button.addEventListener('click', () => {
      const leadId = Number(button.dataset.id);
      const lead = leads.find((item) => item.id === leadId);
      if (!lead) return;
      renderLeadDetails(lead);
    });
  });

  leadList.querySelectorAll('[data-action="edit-lead"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const leadId = Number(button.dataset.id);
      const lead = leads.find((item) => item.id === leadId);
      if (!lead) return;
      populateLeadForm(lead);
      renderLeadDetails(lead);
    });
  });

  leadList.querySelectorAll('[data-action="update-status"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const leadId = Number(button.dataset.id);
      const lead = leads.find((item) => item.id === leadId);
      if (!lead) return;

      const nextIndex = (statusOrder.indexOf(lead.status) + 1) % statusOrder.length;
      const nextStatus = statusOrder[nextIndex];

      try {
        await fetchJson(`/api/leads/${leadId}`, {
          method: 'PUT',
          body: JSON.stringify({ ...lead, status: nextStatus })
        });
        await refreshDashboard();
      } catch (error) {
        showError(error);
      }
    });
  });

  leadList.querySelectorAll('[data-action="delete-lead"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const leadId = Number(button.dataset.id);
      const confirmed = window.confirm('Delete this lead? This will also remove related follow-up tasks.');
      if (!confirmed) return;

      try {
        await fetchJson(`/api/leads/${leadId}`, { method: 'DELETE' });
        await refreshDashboard();
      } catch (error) {
        showError(error);
      }
    });
  });
}

function renderTasks(tasks) {
  if (!tasks.length) {
    taskList.innerHTML = '<div class="empty-state">No follow-up tasks yet.</div>';
    return;
  }

  taskList.innerHTML = tasks
    .map(
      (task) => `
        <article class="list-item">
          <div class="item-header">
            <h4>${escapeHtml(task.title)}</h4>
            <span class="status-pill ${task.completed ? 'status-Won' : 'status-New'}">${task.completed ? 'Completed' : 'Open'}</span>
          </div>
          <div class="item-meta">${escapeHtml(task.lead_name || 'Unknown lead')} • ${escapeHtml(task.lead_company || '')}</div>
          <div class="item-details">
            <div>Due: ${task.due_date ? escapeHtml(task.due_date) : 'No date set'}</div>
            <div>Status: ${task.completed ? 'Completed' : 'Open'}</div>
          </div>
          <div class="item-actions">
            <button class="action-btn secondary" data-action="edit-task" data-id="${task.id}">Edit</button>
            <button class="action-btn" data-action="toggle-task" data-id="${task.id}">${task.completed ? 'Reopen Task' : 'Mark Complete'}</button>
            <button class="delete-btn" data-action="delete-task" data-id="${task.id}">Delete</button>
          </div>
        </article>
      `
    )
    .join('');

  taskList.querySelectorAll('[data-action="edit-task"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const taskId = Number(button.dataset.id);
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return;
      populateTaskForm(task);
    });
  });

  taskList.querySelectorAll('[data-action="toggle-task"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const taskId = Number(button.dataset.id);
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return;

      try {
        await fetchJson(`/api/tasks/${taskId}`, {
          method: 'PUT',
          body: JSON.stringify({ ...task, completed: !task.completed })
        });
        await refreshDashboard();
      } catch (error) {
        showError(error);
      }
    });
  });

  taskList.querySelectorAll('[data-action="delete-task"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const taskId = Number(button.dataset.id);
      const confirmed = window.confirm('Delete this follow-up task?');
      if (!confirmed) return;

      try {
        await fetchJson(`/api/tasks/${taskId}`, { method: 'DELETE' });
        await refreshDashboard();
      } catch (error) {
        showError(error);
      }
    });
  });
}

async function refreshDashboard() {
  setLoadingState();

  try {
    const stats = await fetchJson('/api/dashboard');
    renderStats(stats);

    const leads = await fetchJson(`/api/leads?name=${encodeURIComponent(filterName.value || '')}&company=${encodeURIComponent(filterCompany.value || '')}&status=${encodeURIComponent(filterStatus.value || '')}`);
    renderLeads(leads);

    const tasks = await fetchJson('/api/tasks');
    renderTasks(tasks);
    await populateLeadOptions();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return;
    }
    statsGrid.innerHTML = '<article class="stat-card"><span class="label">System status</span><span class="value">Error</span></article>';
    leadList.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    taskList.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    leadDetailPanel.innerHTML = 'Unable to load lead details. Please refresh and try again.';
  }
}

async function populateLeadOptions() {
  const leads = await fetchJson('/api/leads');
  const currentValue = taskLeadSelect.value;

  taskLeadSelect.innerHTML = ['<option value="">Select a lead</option>']
    .concat(
      leads.map(
        (lead) => `<option value="${lead.id}" ${String(lead.id) === String(currentValue) ? 'selected' : ''}>${escapeHtml(lead.name)} — ${escapeHtml(lead.company)}</option>`
      )
    )
    .join('');
}

function populateLeadForm(lead) {
  editingLeadId = lead.id;
  leadForm.querySelector('[name="name"]').value = lead.name || '';
  leadForm.querySelector('[name="company"]').value = lead.company || '';
  leadForm.querySelector('[name="email"]').value = lead.email || '';
  leadForm.querySelector('[name="phone"]').value = lead.phone || '';
  leadForm.querySelector('[name="source"]').value = lead.source || '';
  leadForm.querySelector('[name="status"]').value = lead.status || 'New';
  leadForm.querySelector('[name="notes"]').value = lead.notes || '';
  leadForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('lead-submit-btn').textContent = 'Update Lead';
}

function clearLeadForm() {
  editingLeadId = null;
  leadForm.reset();
  document.getElementById('lead-submit-btn').textContent = 'Save Lead';
}

function populateTaskForm(task) {
  editingTaskId = task.id;
  taskForm.querySelector('[name="lead_id"]').value = task.lead_id || '';
  taskForm.querySelector('[name="title"]').value = task.title || '';
  taskForm.querySelector('[name="due_date"]').value = task.due_date || '';
  taskForm.querySelector('[name="completed"]').checked = Boolean(task.completed);
  taskForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('task-submit-btn').textContent = 'Update Task';
}

function clearTaskForm() {
  editingTaskId = null;
  taskForm.reset();
  document.getElementById('task-submit-btn').textContent = 'Save Task';
}

leadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(leadForm);
  const payload = {
    name: formData.get('name')?.trim(),
    company: formData.get('company')?.trim(),
    email: formData.get('email')?.trim(),
    phone: formData.get('phone')?.trim(),
    source: formData.get('source')?.trim(),
    status: formData.get('status'),
    notes: formData.get('notes')?.trim()
  };

  try {
    if (editingLeadId) {
      await fetchJson(`/api/leads/${editingLeadId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
    } else {
      await fetchJson('/api/leads', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    }
    clearLeadForm();
    await refreshDashboard();
  } catch (error) {
    showError(error);
  }
});

leadCancelBtn.addEventListener('click', () => {
  clearLeadForm();
});

leadForm.addEventListener('reset', () => {
  clearLeadForm();
});

taskForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(taskForm);

  const payload = {
    lead_id: Number(formData.get('lead_id')),
    title: formData.get('title')?.trim(),
    due_date: formData.get('due_date') || null,
    completed: Boolean(formData.get('completed'))
  };

  try {
    if (editingTaskId) {
      await fetchJson(`/api/tasks/${editingTaskId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
    } else {
      await fetchJson('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    }
    clearTaskForm();
    await refreshDashboard();
  } catch (error) {
    showError(error);
  }
});

taskCancelBtn.addEventListener('click', () => {
  clearTaskForm();
});

taskForm.addEventListener('reset', () => {
  clearTaskForm();
});

[filterName, filterCompany, filterStatus].forEach((element) => {
  element.addEventListener('input', async () => {
    await refreshDashboard();
  });
  element.addEventListener('change', async () => {
    await refreshDashboard();
  });
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

loginTab.addEventListener('click', () => setAuthMode('login'));
registerTab.addEventListener('click', () => setAuthMode('register'));

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitAuth(loginForm, '/api/auth/login');
});

registerForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitAuth(registerForm, '/api/auth/register');
});

logoutBtn.addEventListener('click', async () => {
  try {
    await fetchJson('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    console.error(error);
  }
  showAuthScreen();
  setAuthMode('login');
});

boot();
