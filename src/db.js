const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const databasePath = process.env.DB_PATH || path.join(dataDir, 'leadflow.db');
const db = new sqlite3.Database(databasePath);

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

async function initializeDatabase() {
  await run('PRAGMA foreign_keys = ON');

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

  await seedSampleData();
}

async function seedSampleData() {
  const leadCount = await get('SELECT COUNT(*) AS total FROM leads');
  if (leadCount.total > 0) {
    return;
  }

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
      `INSERT INTO leads (name, company, email, phone, source, status, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [lead.name, lead.company, lead.email, lead.phone, lead.source, lead.status, lead.notes]
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
      `INSERT INTO tasks (lead_id, title, due_date, completed, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [task.leadId, task.title, task.dueDate, task.completed ? 1 : 0]
    );
  }
}

function futureDate(daysFromNow) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().split('T')[0];
}

async function getDashboardStats() {
  const totalLeads = await get('SELECT COUNT(*) AS count FROM leads');
  const newLeads = await get("SELECT COUNT(*) AS count FROM leads WHERE status = 'New'");
  const activeLeads = await get("SELECT COUNT(*) AS count FROM leads WHERE status IN ('New', 'Contacted', 'Qualified')");
  const upcomingFollowUps = await get("SELECT COUNT(*) AS count FROM tasks WHERE completed = 0 AND (due_date IS NULL OR due_date >= date('now'))");

  return {
    totalLeads: totalLeads.count,
    newLeads: newLeads.count,
    activeLeads: activeLeads.count,
    upcomingFollowUps: upcomingFollowUps.count
  };
}

async function getLeads({ name = '', company = '', status = '' } = {}) {
  let sql = 'SELECT * FROM leads';
  const filters = [];
  const params = [];

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

async function getLeadById(id) {
  return get('SELECT * FROM leads WHERE id = ?', [id]);
}

async function createLead(data) {
  const { name, company, email, phone, source, status, notes } = data;
  const createdAt = new Date().toISOString();

  const result = await run(
    `INSERT INTO leads (name, company, email, phone, source, status, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, company, email || null, phone || null, source, status, notes || null, createdAt]
  );

  return getLeadById(result.id);
}

const ALLOWED_LEAD_UPDATE_FIELDS = new Set(['name', 'company', 'email', 'phone', 'source', 'status', 'notes']);
const ALLOWED_TASK_UPDATE_FIELDS = new Set(['lead_id', 'title', 'due_date', 'completed']);

async function updateLead(id, data) {
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
    return getLeadById(id);
  }

  params.push(id);
  await run(`UPDATE leads SET ${fields.join(', ')} WHERE id = ?`, params);
  return getLeadById(id);
}

async function deleteLead(id) {
  await run('DELETE FROM leads WHERE id = ?', [id]);
}

async function getTasks({ leadId = null } = {}) {
  let sql = `
    SELECT t.*, l.name AS lead_name, l.company AS lead_company
    FROM tasks t
    LEFT JOIN leads l ON l.id = t.lead_id
  `;
  const params = [];

  if (leadId) {
    sql += ' WHERE t.lead_id = ?';
    params.push(Number(leadId));
  }

  sql += ' ORDER BY t.due_date ASC, t.completed ASC, t.created_at DESC';
  return all(sql, params);
}

async function getTaskById(id) {
  return get('SELECT * FROM tasks WHERE id = ?', [id]);
}

async function createTask(data) {
  const { lead_id, title, due_date, completed = false } = data;
  const result = await run(
    `INSERT INTO tasks (lead_id, title, due_date, completed, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
    [lead_id, title, due_date || null, completed ? 1 : 0]
  );

  return getTaskById(result.id);
}

async function updateTask(id, data) {
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
    return getTaskById(id);
  }

  params.push(id);
  await run(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`, params);
  return getTaskById(id);
}

async function deleteTask(id) {
  await run('DELETE FROM tasks WHERE id = ?', [id]);
}

async function resetDatabase() {
  await initializeDatabase();
  await run('DELETE FROM tasks');
  await run('DELETE FROM sqlite_sequence WHERE name = ?', ['tasks']);
  await run('DELETE FROM leads');
  await run('DELETE FROM sqlite_sequence WHERE name = ?', ['leads']);
  await seedSampleData();
}

module.exports = {
  db,
  initializeDatabase,
  getDashboardStats,
  getLeads,
  getLeadById,
  createLead,
  updateLead,
  deleteLead,
  getTasks,
  getTaskById,
  createTask,
  updateTask,
  deleteTask,
  resetDatabase
};
