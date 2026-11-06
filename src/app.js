const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');

const {
  initializeDatabase,
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
  recordWorkflowEvent,
  getWorkflowEvents,
  all,
  resetDatabase
} = require('./db');

const app = express();
const LEAD_STATUSES = ['New', 'Contacted', 'Qualified', 'Won', 'Lost'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SALT_ROUNDS = 12;
const SESSION_SECRET = process.env.SESSION_SECRET || 'development-session-secret-change-me';

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  const { password_hash, ...safeUser } = user;
  return safeUser;
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function normalizeString(value) {
  if (value === undefined || value === null) {
    return value;
  }
  return String(value).trim();
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }
  return next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ message: 'Authentication required.' });
    }

    if (req.session.user.role !== role && req.session.user.role !== 'owner' && req.session.user.role !== 'admin') {
      return res.status(403).json({ message: 'You do not have access to this resource.' });
    }
    return next();
  };
}

function normalizeLeadInput(data = {}) {
  const normalized = {};
  const allowedFields = ['name', 'company', 'email', 'phone', 'source', 'status', 'notes'];

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      let value = data[field];
      if (value === null || value === undefined) {
        normalized[field] = value;
        continue;
      }
      normalized[field] = typeof value === 'string' ? value.trim() : value;
    }
  }

  return normalized;
}

function normalizeTaskInput(data = {}) {
  const normalized = {};
  const allowedFields = ['lead_id', 'title', 'due_date', 'completed'];

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      let value = data[field];
      if (value === null || value === undefined) {
        normalized[field] = value;
        continue;
      }
      normalized[field] = typeof value === 'string' ? value.trim() : value;
    }
  }

  return normalized;
}

function validateLead(data, { allowPartial = false } = {}) {
  const payload = normalizeLeadInput(data || {});

  if (!allowPartial) {
    if (!payload.name || !String(payload.name).trim()) return { error: 'Lead name is required.' };
    if (!payload.company || !String(payload.company).trim()) return { error: 'Company is required.' };
    if (!payload.source || !String(payload.source).trim()) return { error: 'Lead source is required.' };
    if (!payload.status || !LEAD_STATUSES.includes(payload.status)) {
      return { error: 'Status must be one of New, Contacted, Qualified, Won, or Lost.' };
    }
  }

  if (payload.name !== undefined && !String(payload.name).trim()) {
    return { error: 'Lead name cannot be empty.' };
  }
  if (payload.company !== undefined && !String(payload.company).trim()) {
    return { error: 'Company cannot be empty.' };
  }
  if (payload.source !== undefined && !String(payload.source).trim()) {
    return { error: 'Source cannot be empty.' };
  }
  if (payload.status !== undefined && payload.status !== null && !LEAD_STATUSES.includes(payload.status)) {
    return { error: 'Status must be one of New, Contacted, Qualified, Won, or Lost.' };
  }
  if (payload.email !== undefined && payload.email !== null && payload.email !== '' && !EMAIL_REGEX.test(String(payload.email).trim())) {
    return { error: 'Email must be a valid address.' };
  }
  if (payload.phone !== undefined && payload.phone !== null && payload.phone !== '') {
    const digitsOnly = String(payload.phone).replace(/[^0-9+()\-\s]/g, '');
    if (digitsOnly.length < 7 || digitsOnly.length > 20) {
      return { error: 'Phone number must be between 7 and 20 characters.' };
    }
  }

  return { normalized: payload };
}

function validateTask(data, { allowPartial = false } = {}) {
  const payload = normalizeTaskInput(data || {});

  if (!allowPartial) {
    if (!payload.lead_id || Number.isNaN(Number(payload.lead_id))) {
      return { error: 'A valid lead ID is required for the task.' };
    }
    if (!payload.title || !String(payload.title).trim()) {
      return { error: 'Task title is required.' };
    }
  }

  if (payload.lead_id !== undefined && payload.lead_id !== null && payload.lead_id !== '') {
    const leadId = Number(payload.lead_id);
    if (!Number.isInteger(leadId) || leadId <= 0) {
      return { error: 'Lead ID must be a positive integer.' };
    }
    payload.lead_id = leadId;
  }

  if (payload.title !== undefined && payload.title !== null && payload.title !== '') {
    const title = String(payload.title).trim();
    if (!title) {
      return { error: 'Task title cannot be empty.' };
    }
    payload.title = title;
  }

  if (payload.due_date !== undefined && payload.due_date !== null && payload.due_date !== '') {
    const dateValue = String(payload.due_date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
      return { error: 'Due date must be a valid YYYY-MM-DD value.' };
    }
    const date = new Date(`${dateValue}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
      return { error: 'Due date must be a valid calendar date.' };
    }
    payload.due_date = dateValue;
  }

  if (payload.completed !== undefined && payload.completed !== null) {
    if (typeof payload.completed === 'string') {
      const lower = payload.completed.toLowerCase();
      if (lower === 'true') payload.completed = true;
      else if (lower === 'false') payload.completed = false;
      else if (lower === '1') payload.completed = true;
      else if (lower === '0') payload.completed = false;
      else return { error: 'Task completion must be true or false.' };
    }
    if (typeof payload.completed !== 'boolean' && payload.completed !== 0 && payload.completed !== 1) {
      return { error: 'Task completion must be true or false.' };
    }
    payload.completed = Boolean(payload.completed);
  }

  return { normalized: payload };
}

function validateAuthInput(data) {
  const name = normalizeString(data.name);
  const email = normalizeString(data.email);
  const password = typeof data.password === 'string' ? data.password : '';

  if (!name || !email || !password) {
    throw new Error('Name, email, and password are required.');
  }

  if (!EMAIL_REGEX.test(email)) {
    throw new Error('Please provide a valid email address.');
  }

  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }

  return { name, email, password };
}

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigin = !origin
      || origin === 'http://localhost:3000'
      || origin === 'http://localhost:3001'
      || /^http:\/\/localhost:\d+$/.test(origin)
      || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)
      || /^https?:\/\/.*\.githubpreview\.dev$/.test(origin);

    if (allowedOrigin) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin not allowed by CORS policy.'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please try again shortly.' }
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 12
  }
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'LeadFlow OS' });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = validateAuthInput(req.body || {});
    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ message: 'An account for this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const organizationId = await createOrganization('LeadFlow OS Demo');
    const user = await createUser({ name, email, passwordHash, organizationId, role: 'owner' });
    await recordWorkflowEvent(organizationId, 'user_registered', { userId: user.id, email: user.email });

    req.session.user = sanitizeUser(user);
    return res.status(201).json({
      message: 'Account created successfully.',
      user: req.session.user
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || 'Registration failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = normalizeString(req.body && req.body.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!EMAIL_REGEX.test(email) || password.length < 8) {
      return res.status(400).json({ message: 'Invalid email or password.' });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    req.session.user = sanitizeUser(user);
    return res.json({
      message: 'Login successful.',
      user: req.session.user
    });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to log in.', error: error.message });
  }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({ message: 'Unable to log out.' });
    }
    return res.json({ message: 'Logged out successfully.' });
  });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.session.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }
    return res.json({ user: sanitizeUser(user) });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to load user profile.' });
  }
});

app.get('/api/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const rows = await all('SELECT id, name, email, role, organization_id, created_at FROM users ORDER BY created_at DESC');
    return res.json({ users: rows });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to load users.', error: error.message });
  }
});

app.get('/api/admin/workflow-events', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const events = await getWorkflowEvents({ organizationId: req.session.user.organization_id });
    return res.json({ events });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to load workflow events.', error: error.message });
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const stats = await getDashboardStats();
    return res.json(stats);
  } catch (error) {
    return res.status(500).json({ message: 'Unable to load dashboard stats.', error: error.message });
  }
});

app.get('/api/leads', async (req, res) => {
  try {
    const leads = await getLeads({
      name: normalizeString(req.query.name),
      company: normalizeString(req.query.company),
      status: normalizeString(req.query.status)
    });
    return res.json(leads);
  } catch (error) {
    return res.status(500).json({ message: 'Unable to load leads.', error: error.message });
  }
});

app.get('/api/leads/:id', async (req, res) => {
  try {
    const id = parsePositiveInteger(req.params.id, 'Lead ID');
    const lead = await getLeadById(id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }
    return res.json(lead);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

app.post('/api/leads', async (req, res) => {
  try {
    const validation = validateLead(req.body);
    if (validation.error) {
      return res.status(400).json({ message: validation.error });
    }

    const lead = await createLead(validation.normalized);
    return res.status(201).json(lead);
  } catch (error) {
    return res.status(500).json({ message: 'Unable to create lead.', error: error.message });
  }
});

app.put('/api/leads/:id', async (req, res) => {
  try {
    const id = parsePositiveInteger(req.params.id, 'Lead ID');
    const lead = await getLeadById(id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    const validation = validateLead(req.body, { allowPartial: true });
    if (validation.error) {
      return res.status(400).json({ message: validation.error });
    }

    const updatedLead = await updateLead(id, validation.normalized);
    return res.json(updatedLead);
  } catch (error) {
    return res.status(error.message.includes('Lead ID') ? 400 : 500).json({
      message: error.message || 'Unable to update lead.'
    });
  }
});

app.delete('/api/leads/:id', async (req, res) => {
  try {
    const id = parsePositiveInteger(req.params.id, 'Lead ID');
    const lead = await getLeadById(id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    await deleteLead(id);
    return res.json({ message: 'Lead deleted successfully.' });
  } catch (error) {
    return res.status(error.message.includes('Lead ID') ? 400 : 500).json({
      message: error.message || 'Unable to delete lead.'
    });
  }
});

app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await getTasks({
      leadId: req.query.leadId ? parsePositiveInteger(req.query.leadId, 'Lead ID') : null
    });
    return res.json(tasks);
  } catch (error) {
    return res.status(400).json({ message: error.message || 'Invalid filter data.' });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const validation = validateTask(req.body);
    if (validation.error) {
      return res.status(400).json({ message: validation.error });
    }

    const lead = await getLeadById(validation.normalized.lead_id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found for the task.' });
    }

    const task = await createTask(validation.normalized);
    return res.status(201).json(task);
  } catch (error) {
    return res.status(500).json({ message: 'Unable to create task.', error: error.message });
  }
});

app.put('/api/tasks/:id', async (req, res) => {
  try {
    const id = parsePositiveInteger(req.params.id, 'Task ID');
    const task = await getTaskById(id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found.' });
    }

    const validation = validateTask(req.body, { allowPartial: true });
    if (validation.error) {
      return res.status(400).json({ message: validation.error });
    }

    if (validation.normalized.lead_id !== undefined) {
      const lead = await getLeadById(validation.normalized.lead_id);
      if (!lead) {
        return res.status(404).json({ message: 'Lead not found for the task.' });
      }
    }

    const updatedTask = await updateTask(id, validation.normalized);
    return res.json(updatedTask);
  } catch (error) {
    return res.status(error.message.includes('Task ID') ? 400 : 500).json({
      message: error.message || 'Unable to update task.'
    });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const id = parsePositiveInteger(req.params.id, 'Task ID');
    const task = await getTaskById(id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found.' });
    }

    await deleteTask(id);
    return res.json({ message: 'Task deleted successfully.' });
  } catch (error) {
    return res.status(error.message.includes('Task ID') ? 400 : 500).json({
      message: error.message || 'Unable to delete task.'
    });
  }
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ message: 'API endpoint not found.' });
  }
  return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({
      message: 'Unexpected server error.',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
  return next(error);
});

async function startServer(port = 3000) {
  await initializeDatabase();
  return app.listen(port, () => {
    console.log(`LeadFlow OS running at http://localhost:${port}`);
  });
}

initializeDatabase().catch((error) => {
  console.error('Failed to initialize LeadFlow OS database:', error.message);
});

module.exports = {
  app,
  startServer,
  resetDatabase
};
