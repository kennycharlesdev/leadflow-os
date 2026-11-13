const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dataDir = path.join(__dirname, '..', 'data');
const backupDir = path.join(dataDir, 'backups');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });

const databasePath = process.env.DB_PATH || path.join(dataDir, 'leadflow.db');
const db = new sqlite3.Database(databasePath);

let initializationPromise = null;
let migrationsApplied = false;

const LEAD_STATUSES = ['New', 'Contacted', 'Qualified', 'Won', 'Lost'];
const DEFAULT_ORGANIZATION_NAME = 'LeadFlow OS Demo';

async function ensureTableColumn(tableName, columnName, columnDef) {
  const columns = await all(`PRAGMA table_info(${tableName})`);
  const exists = columns.some((column) => column.name === columnName);
  if (!exists) {
    try {
      await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
    } catch (error) {
      if (!/duplicate column name/i.test(error.message)) {
        throw error;
      }
    }
  }
}

async function ensureSchemaCompatibility() {
  await run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

  const migrations = [
    {
      version: 1,
      sql: `CREATE TABLE IF NOT EXISTS organizations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    },
    {
      version: 2,
      sql: `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      )`
    },
    {
      version: 3,
      sql: `CREATE TABLE IF NOT EXISTS workflow_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        event_data TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      )`
    },
    {
      version: 4,
      sql: `CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    }
  ];

  for (const migration of migrations) {
    const exists = await get('SELECT version FROM schema_migrations WHERE version = ?', [migration.version]);
    if (!exists) {
      await run(migration.sql);
      await run('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
    }
  }

  await ensureTableColumn('leads', 'organization_id', 'INTEGER');
  await ensureTableColumn('tasks', 'organization_id', 'INTEGER');

  const defaultOrganizationId = await ensureDefaultOrganization();
  await run('UPDATE leads SET organization_id = ? WHERE organization_id IS NULL', [defaultOrganizationId]);
  await run('UPDATE tasks SET organization_id = ? WHERE organization_id IS NULL', [defaultOrganizationId]);
  migrationsApplied = true;
}
const ALLOWED_LEAD_UPDATE_FIELDS = new Set(['name', 'company', 'email', 'phone', 'source', 'status', 'notes']);
const ALLOWED_TASK_UPDATE_FIELDS = new Set(['lead_id', 'title', 'due_date', 'completed']);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

function futureDate(daysFromNow) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().split('T')[0];
}

function backupDatabase() {
  if (!fs.existsSync(databasePath)) {
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `leadflow-backup-${timestamp}.db`);
  fs.copyFileSync(databasePath, backupPath);
  return backupPath;
}

async function initializeDatabase() {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    await run('PRAGMA foreign_keys = ON');
    await run('PRAGMA journal_mode = WAL');

    if (!migrationsApplied) {
      backupDatabase();
    }

    await run(`
      CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        company TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('New', 'Contacted', 'Qualified', 'Won', 'Lost')),
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        due_date TEXT,
        completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
      )
    `);

    await ensureSchemaCompatibility();

    await ensureDefaultOrganization();
    await seedSampleData();
  })();

  try {
    return await initializationPromise;
  } finally {
    initializationPromise = null;
  }
}

async function ensureDefaultOrganization() {
  const existing = await get('SELECT id FROM organizations WHERE name = ?', [DEFAULT_ORGANIZATION_NAME]);
  if (existing) {
    return existing.id;
  }

  try {
    const result = await run('INSERT INTO organizations (name, created_at) VALUES (?, datetime("now"))', [DEFAULT_ORGANIZATION_NAME]);
    return result.id;
  } catch (error) {
    if (error.code !== 'SQLITE_CONSTRAINT') {
      throw error;
    }
    const fallback = await get('SELECT id FROM organizations WHERE name = ?', [DEFAULT_ORGANIZATION_NAME]);
    if (fallback) {
      return fallback.id;
    }
    throw error;
  }
}

async function seedSampleData() {
  const leadCount = await get('SELECT COUNT(*) AS total FROM leads');
  if (leadCount.total > 0) {
    return;
  }

  const organizationId = await ensureDefaultOrganization();

  const sampleLeads = [
    {
      name: 'Avery Stone',
      company: 'Northline Labs',
      email: 'avery@northlinelabs.example',
      phone: '555-0101',
      source: 'Website',
      status: 'New',
      notes: 'Interested in automation workflow demo.'
    },
    {
      name: 'Mila Green',
      company: 'Summit Health',
      email: 'mila@summithealth.example',
      phone: '555-0102',
      source: 'Referral',
      status: 'Contacted',
      notes: 'Requested pricing and onboarding details.'
    },
    {
      name: 'Daniel Brooks',
      company: 'Harbor Retail',
      email: 'daniel@harborretail.example',
      phone: '555-0103',
      source: 'LinkedIn',
      status: 'Qualified',
      notes: 'Good fit for a lead tracking workflow.'
    },
    {
      name: 'Priya Shah',
      company: 'Luna Creative',
      email: 'priya@lunacreative.example',
      phone: '555-0104',
      source: 'Website',
      status: 'Won',
      notes: 'Customer onboarding completed.'
    }
  ];

  for (const lead of sampleLeads) {
    await run(
      `INSERT INTO leads (organization_id, name, company, email, phone, source, status, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [organizationId, lead.name, lead.company, lead.email, lead.phone, lead.source, lead.status, lead.notes]
    );
  }

  const leadRows = await all('SELECT id FROM leads ORDER BY id');
  const tasks = [
    { leadId: leadRows[0] ? leadRows[0].id : 1, title: 'Send product overview', dueDate: futureDate(2), completed: 0 },
    { leadId: leadRows[1] ? leadRows[1].id : 1, title: 'Schedule discovery call', dueDate: futureDate(4), completed: 0 },
    { leadId: leadRows[2] ? leadRows[2].id : 1, title: 'Send proposal follow-up', dueDate: futureDate(6), completed: 1 }
  ];

  for (const task of tasks) {
    await run(
      `INSERT INTO tasks (organization_id, lead_id, title, due_date, completed, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [organizationId, task.leadId, task.title, task.dueDate, task.completed ? 1 : 0]
    );
  }
}

async function getDashboardStats({ organizationId = null } = {}) {
  const params = [];
  let sql = 'SELECT COUNT(*) AS count FROM leads';
  if (organizationId !== null && organizationId !== undefined) {
    sql += ' WHERE organization_id = ?';
    params.push(Number(organizationId));
  }
  const totalLeads = await get(sql, params);

  let newLeadsSql = "SELECT COUNT(*) AS count FROM leads WHERE status = 'New'";
  const newLeadParams = [];
  if (organizationId !== null && organizationId !== undefined) {
    newLeadsSql += ' AND organization_id = ?';
    newLeadParams.push(Number(organizationId));
  }
  const newLeads = await get(newLeadsSql, newLeadParams);

  let activeLeadsSql = "SELECT COUNT(*) AS count FROM leads WHERE status IN ('New', 'Contacted', 'Qualified')";
  const activeLeadParams = [];
  if (organizationId !== null && organizationId !== undefined) {
    activeLeadsSql += ' AND organization_id = ?';
    activeLeadParams.push(Number(organizationId));
  }
  const activeLeads = await get(activeLeadsSql, activeLeadParams);

  let wonLeadsSql = "SELECT COUNT(*) AS count FROM leads WHERE status = 'Won'";
  const wonLeadParams = [];
  if (organizationId !== null && organizationId !== undefined) {
    wonLeadsSql += ' AND organization_id = ?';
    wonLeadParams.push(Number(organizationId));
  }
  const wonLeads = await get(wonLeadsSql, wonLeadParams);

  let pendingFollowUpsSql = "SELECT COUNT(*) AS count FROM tasks WHERE completed = 0 AND (due_date IS NULL OR due_date >= date('now'))";
  const pendingFollowUpParams = [];
  if (organizationId !== null && organizationId !== undefined) {
    pendingFollowUpsSql += ' AND organization_id = ?';
    pendingFollowUpParams.push(Number(organizationId));
  }
  const pendingFollowUps = await get(pendingFollowUpsSql, pendingFollowUpParams);

  let overdueTasksSql = "SELECT COUNT(*) AS count FROM tasks WHERE completed = 0 AND due_date IS NOT NULL AND due_date < date('now')";
  const overdueTasksParams = [];
  if (organizationId !== null && organizationId !== undefined) {
    overdueTasksSql += ' AND organization_id = ?';
    overdueTasksParams.push(Number(organizationId));
  }
  const overdueTasks = await get(overdueTasksSql, overdueTasksParams);

  return {
    totalLeads: Number(totalLeads.count),
    newLeads: Number(newLeads.count),
    activeLeads: Number(activeLeads.count),
    wonLeads: Number(wonLeads.count),
    pendingFollowUps: Number(pendingFollowUps.count),
    overdueTasks: Number(overdueTasks.count)
  };
}

async function getLeads({ name = '', company = '', status = '', organizationId = null } = {}) {
  let sql = 'SELECT * FROM leads';
  const filters = [];
  const params = [];

  if (organizationId !== null && organizationId !== undefined) {
    filters.push('organization_id = ?');
    params.push(Number(organizationId));
  }

  if (name) {
    filters.push('LOWER(name) LIKE ?');
    params.push(`%${String(name).toLowerCase()}%`);
  }

  if (company) {
    filters.push('LOWER(company) LIKE ?');
    params.push(`%${String(company).toLowerCase()}%`);
  }

  if (status) {
    filters.push('status = ?');
    params.push(status);
  }

  if (filters.length) {
    sql += ` WHERE ${filters.join(' AND ')}`;
  }

  sql += ' ORDER BY created_at DESC';

  return all(sql, params);
}

async function getLeadById(id, organizationId = null) {
  let sql = 'SELECT * FROM leads WHERE id = ?';
  const params = [id];

  if (organizationId !== null && organizationId !== undefined) {
    sql += ' AND organization_id = ?';
    params.push(Number(organizationId));
  }

  return get(sql, params);
}

async function createLead(data, organizationId) {
  const { name, company, email, phone, source, status, notes } = data;
  const finalOrganizationId = Number(organizationId) || (await ensureDefaultOrganization());

  const result = await run(
    `INSERT INTO leads (organization_id, name, company, email, phone, source, status, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [finalOrganizationId, name, company, email || null, phone || null, source, status, notes || null]
  );

  return getLeadById(result.id, finalOrganizationId);
}

async function updateLead(id, data, organizationId = null) {
  const fields = [];
  const params = [];

  for (const [key, value] of Object.entries(data)) {
    if (!ALLOWED_LEAD_UPDATE_FIELDS.has(key)) {
      continue;
    }

    if (value === undefined) {
      continue;
    }

    fields.push(`${key} = ?`);
    params.push(value === null ? null : value);
  }

  if (!fields.length) {
    return getLeadById(id, organizationId);
  }

  params.push(id);
  if (organizationId !== null && organizationId !== undefined) {
    await run(`UPDATE leads SET ${fields.join(', ')} WHERE id = ? AND organization_id = ?`, [...params, Number(organizationId)]);
    return getLeadById(id, organizationId);
  }

  await run(`UPDATE leads SET ${fields.join(', ')} WHERE id = ?`, params);
  return getLeadById(id);
}

async function deleteLead(id, organizationId = null) {
  if (organizationId !== null && organizationId !== undefined) {
    await run('DELETE FROM leads WHERE id = ? AND organization_id = ?', [id, Number(organizationId)]);
    return;
  }

  await run('DELETE FROM leads WHERE id = ?', [id]);
}

async function getTasks({ leadId = null, organizationId = null } = {}) {
  let sql = `
    SELECT t.*, l.name AS lead_name, l.company AS lead_company
    FROM tasks t
    LEFT JOIN leads l ON l.id = t.lead_id
  `;
  const params = [];
  const filters = [];

  if (organizationId !== null && organizationId !== undefined) {
    filters.push('t.organization_id = ?');
    params.push(Number(organizationId));
  }

  if (leadId) {
    filters.push('t.lead_id = ?');
    params.push(Number(leadId));
  }

  if (filters.length) {
    sql += ' WHERE ' + filters.join(' AND ');
  }

  sql += ' ORDER BY t.due_date ASC, t.completed ASC, t.created_at DESC';
  return all(sql, params);
}

async function getTaskById(id, organizationId = null) {
  let sql = 'SELECT * FROM tasks WHERE id = ?';
  const params = [id];

  if (organizationId !== null && organizationId !== undefined) {
    sql += ' AND organization_id = ?';
    params.push(Number(organizationId));
  }

  return get(sql, params);
}

async function createTask(data, organizationId) {
  const { lead_id, title, due_date, completed = false } = data;
  const finalOrganizationId = Number(organizationId) || (await ensureDefaultOrganization());

  const result = await run(
    `INSERT INTO tasks (organization_id, lead_id, title, due_date, completed, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [finalOrganizationId, lead_id, title, due_date || null, completed ? 1 : 0]
  );

  return getTaskById(result.id, finalOrganizationId);
}

async function updateTask(id, data, organizationId = null) {
  const fields = [];
  const params = [];

  for (const [key, value] of Object.entries(data)) {
    if (!ALLOWED_TASK_UPDATE_FIELDS.has(key)) {
      continue;
    }

    if (value === undefined) {
      continue;
    }

    if (key === 'completed') {
      fields.push('completed = ?');
      params.push(Number(Boolean(value)));
      continue;
    }

    fields.push(`${key} = ?`);
    params.push(value === null ? null : value);
  }

  if (!fields.length) {
    return getTaskById(id, organizationId);
  }

  params.push(id);
  if (organizationId !== null && organizationId !== undefined) {
    await run(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ? AND organization_id = ?`, [...params, Number(organizationId)]);
    return getTaskById(id, organizationId);
  }

  await run(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`, params);
  return getTaskById(id);
}

async function deleteTask(id, organizationId = null) {
  if (organizationId !== null && organizationId !== undefined) {
    await run('DELETE FROM tasks WHERE id = ? AND organization_id = ?', [id, Number(organizationId)]);
    return;
  }

  await run('DELETE FROM tasks WHERE id = ?', [id]);
}

async function createOrganization(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    throw new Error('Organization name is required.');
  }

  let candidateName = trimmed;
  let suffix = 2;

  while (true) {
    const existing = await get('SELECT id FROM organizations WHERE lower(name) = ?', [candidateName.toLowerCase()]);
    if (!existing) {
      break;
    }
    candidateName = `${trimmed} ${suffix}`;
    suffix += 1;
  }

  try {
    const result = await run('INSERT INTO organizations (name, created_at) VALUES (?, datetime("now"))', [candidateName]);
    return result.id;
  } catch (error) {
    if (error.code !== 'SQLITE_CONSTRAINT') {
      throw error;
    }
    const fallback = await get('SELECT id FROM organizations WHERE lower(name) = ?', [candidateName.toLowerCase()]);
    if (fallback) {
      return fallback.id;
    }
    throw error;
  }
}

async function getOrganizationById(id) {
  return get('SELECT * FROM organizations WHERE id = ?', [id]);
}

async function getUserByEmail(email) {
  return get('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [String(email || '').trim()]);
}

async function getUserById(id) {
  return get('SELECT * FROM users WHERE id = ?', [id]);
}

async function createUser({ name, email, passwordHash, organizationId, role = 'member' }) {
  const trimmedName = String(name || '').trim();
  const trimmedEmail = String(email || '').trim();
  if (!trimmedName || !trimmedEmail || !passwordHash) {
    throw new Error('Name, email, and password are required.');
  }

  const organizationIdValue = Number(organizationId) || (await ensureDefaultOrganization());
  const result = await run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [organizationIdValue, trimmedName, trimmedEmail, passwordHash, role]
  );

  return getUserById(result.id);
}

async function recordWorkflowEvent(organizationId, eventType, eventData = {}) {
  const payload = JSON.stringify(eventData);
  await run(
    `INSERT INTO workflow_events (organization_id, event_type, event_data, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [organizationId, eventType, payload]
  );
}

async function getWorkflowEvents({ organizationId = null } = {}) {
  let sql = 'SELECT * FROM workflow_events';
  const params = [];

  if (organizationId) {
    sql += ' WHERE organization_id = ?';
    params.push(Number(organizationId));
  }

  sql += ' ORDER BY created_at DESC LIMIT 50';
  return all(sql, params);
}

async function resetDatabase() {
  const testDbPath = String(process.env.DB_PATH || '').toLowerCase();
  if (!testDbPath.includes('test') && !testDbPath.includes('tmp')) {
    throw new Error('Database reset is only allowed for test databases.');
  }

  // Make sure the schema exists before clearing it (a fresh clone has no database yet).
  await initializeDatabase();

  await run('DELETE FROM tasks');
  await run('DELETE FROM leads');
  await run('DELETE FROM workflow_events');
  await run('DELETE FROM users');
  await run('DELETE FROM organizations');

  await run('DELETE FROM sqlite_sequence WHERE name = ?', ['tasks']);
  await run('DELETE FROM sqlite_sequence WHERE name = ?', ['leads']);
  await run('DELETE FROM sqlite_sequence WHERE name = ?', ['workflow_events']);
  await run('DELETE FROM sqlite_sequence WHERE name = ?', ['users']);
  await run('DELETE FROM sqlite_sequence WHERE name = ?', ['organizations']);

  await ensureDefaultOrganization();
  await seedSampleData();
}

module.exports = {
  db,
  run,
  get,
  all,
  LEAD_STATUSES,
  initializeDatabase,
  backupDatabase,
  getDashboardStats,
  getLeads,
  createLead,
  getLeadById,
  updateLead,
  deleteLead,
  getTasks,
  getTaskById,
  createTask,
  updateTask,
  deleteTask,
  getUserByEmail,
  getUserById,
  createUser,
  createOrganization,
  getOrganizationById,
  recordWorkflowEvent,
  getWorkflowEvents,
  resetDatabase
};
