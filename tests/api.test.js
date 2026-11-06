const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.DB_PATH = path.join(__dirname, '..', 'data', 'leadflow-test.db');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';

const { app, resetDatabase } = require('../src/app');

async function getCsrfToken(agent) {
  const response = await agent.get('/api/csrf-token');
  assert.equal(response.status, 200);
  return response.body.csrfToken;
}

async function registerUser({ name, email, password }) {
  const agent = request.agent(app);
  const csrfToken = await getCsrfToken(agent);
  const response = await agent
    .post('/api/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name, email, password });
  return { agent, response };
}

test.beforeEach(async () => {
  await resetDatabase();
});

test('GET /api/dashboard requires authentication', async () => {
  const response = await request(app).get('/api/dashboard');
  assert.equal(response.status, 401);
});

test('POST /api/leads requires authentication', async () => {
  const response = await request(app)
    .post('/api/leads')
    .send({
      name: 'Jordan Lee',
      company: 'BluePeak Studio',
      email: 'jordan@bluepeak.example',
      source: 'Website',
      status: 'New'
    });

  assert.equal(response.status, 401);
});

test('POST /api/tasks requires authentication', async () => {
  const response = await request(app)
    .post('/api/tasks')
    .send({
      lead_id: 1,
      title: 'Send follow-up',
      due_date: '2026-11-12',
      completed: false
    });

  assert.equal(response.status, 401);
});

test('POST /api/auth/register creates a new account', async () => {
  const { response } = await registerUser({
    name: 'Sam Rivera',
    email: 'sam@example.com',
    password: 'StrongPass123'
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.user.email, 'sam@example.com');
  assert.equal(response.body.user.role, 'owner');
});

test('POST /api/auth/login authenticates an existing account and rejects invalid passwords', async () => {
  await registerUser({
    name: 'Alex Chen',
    email: 'alex@example.com',
    password: 'StrongPass123'
  });

  const agent = request.agent(app);
  const csrfToken = await getCsrfToken(agent);
  const validLogin = await agent
    .post('/api/auth/login')
    .set('X-CSRF-Token', csrfToken)
    .send({
      email: 'alex@example.com',
      password: 'StrongPass123'
    });

  assert.equal(validLogin.status, 200);
  assert.equal(validLogin.body.user.email, 'alex@example.com');

  const invalidLogin = await agent
    .post('/api/auth/login')
    .set('X-CSRF-Token', csrfToken)
    .send({
      email: 'alex@example.com',
      password: 'wrongpassword'
    });

  assert.equal(invalidLogin.status, 401);
});

test('GET /api/admin/users returns only organization-scoped members', async () => {
  const alpha = await registerUser({ name: 'Alpha User', email: 'alpha@example.com', password: 'StrongPass123' });
  const beta = await registerUser({ name: 'Beta User', email: 'beta@example.com', password: 'StrongPass123' });

  const alphaUsers = await alpha.agent.get('/api/admin/users');
  assert.equal(alphaUsers.status, 200);
  assert.equal(alphaUsers.body.users.length, 1);
  assert.equal(alphaUsers.body.users[0].email, 'alpha@example.com');

  const betaUsers = await beta.agent.get('/api/admin/users');
  assert.equal(betaUsers.status, 200);
  assert.equal(betaUsers.body.users.length, 1);
  assert.equal(betaUsers.body.users[0].email, 'beta@example.com');
});

test('Organization isolation prevents cross-organization lead access', async () => {
  const alpha = await registerUser({ name: 'Alpha Org', email: 'alpha-org@example.com', password: 'StrongPass123' });
  const beta = await registerUser({ name: 'Beta Org', email: 'beta-org@example.com', password: 'StrongPass123' });

  const alphaToken = await getCsrfToken(alpha.agent);
  const betaToken = await getCsrfToken(beta.agent);

  const alphaLead = await alpha.agent
    .post('/api/leads')
    .set('X-CSRF-Token', alphaToken)
    .send({
      name: 'Alpha Lead',
      company: 'Alpha Company',
      source: 'Website',
      status: 'New',
      email: 'alpha-lead@example.com'
    });

  const betaLead = await beta.agent
    .post('/api/leads')
    .set('X-CSRF-Token', betaToken)
    .send({
      name: 'Beta Lead',
      company: 'Beta Company',
      source: 'Referral',
      status: 'Qualified',
      email: 'beta-lead@example.com'
    });

  const alphaList = await alpha.agent.get('/api/leads');
  assert.equal(alphaList.status, 200);
  assert.deepEqual(alphaList.body.map((lead) => lead.id), [alphaLead.body.id]);

  const betaList = await beta.agent.get('/api/leads');
  assert.equal(betaList.status, 200);
  assert.deepEqual(betaList.body.map((lead) => lead.id), [betaLead.body.id]);

  const otherLeadAccess = await alpha.agent.get(`/api/leads/${betaLead.body.id}`);
  assert.equal(otherLeadAccess.status, 404);

  const crossUpdate = await alpha.agent
    .put(`/api/leads/${betaLead.body.id}`)
    .set('X-CSRF-Token', alphaToken)
    .send({ status: 'Won' });
  assert.equal(crossUpdate.status, 404);

  const crossDelete = await alpha.agent
    .delete(`/api/leads/${betaLead.body.id}`)
    .set('X-CSRF-Token', alphaToken);
  assert.equal(crossDelete.status, 404);
});

test('GET /api/leads supports filtering for the authenticated organization', async () => {
  const user = await registerUser({ name: 'Taylor Gray', email: 'taylor@example.com', password: 'StrongPass123' });
  const csrfToken = await getCsrfToken(user.agent);

  await user.agent
    .post('/api/leads')
    .set('X-CSRF-Token', csrfToken)
    .send({
      name: 'Taylor Gray',
      company: 'Oak & Pine',
      email: 'taylor@oakpine.example',
      source: 'Referral',
      status: 'Qualified',
      notes: 'Needs a proposal.'
    });

  const response = await user.agent.get('/api/leads').query({ status: 'Qualified' });
  assert.equal(response.status, 200);
  assert.ok(response.body.some((lead) => lead.name === 'Taylor Gray'));
});

test('POST /api/leads rejects malformed email addresses', async () => {
  const user = await registerUser({ name: 'Morgan Price', email: 'morgan@example.com', password: 'StrongPass123' });
  const csrfToken = await getCsrfToken(user.agent);

  const response = await user.agent
    .post('/api/leads')
    .set('X-CSRF-Token', csrfToken)
    .send({
      name: 'Morgan Price',
      company: 'Silverline',
      email: 'not-an-email',
      source: 'Website',
      status: 'New'
    });

  assert.equal(response.status, 400);
  assert.match(response.body.message, /Email/);
});
