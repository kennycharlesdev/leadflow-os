const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const path = require('path');

process.env.PORT = '3001';
process.env.DB_PATH = path.join(__dirname, '..', 'data', 'leadflow-test.db');

const { app, resetDatabase } = require('../src/app');

test.beforeEach(async () => {
  await resetDatabase();
});

test('GET /api/dashboard returns summary counts', async () => {
  const response = await request(app).get('/api/dashboard');
  assert.equal(response.status, 200);
  assert.equal(typeof response.body.totalLeads, 'number');
  assert.equal(typeof response.body.newLeads, 'number');
  assert.equal(typeof response.body.activeLeads, 'number');
  assert.equal(typeof response.body.upcomingFollowUps, 'number');
});

test('POST /api/leads creates a lead and stores expected fields', async () => {
  const response = await request(app)
    .post('/api/leads')
    .send({
      name: 'Jordan Lee',
      company: 'BluePeak Studio',
      email: 'jordan@bluepeak.example',
      phone: '555-0212',
      source: 'Website',
      status: 'New',
      notes: 'Interested in onboarding.'
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.name, 'Jordan Lee');
  assert.equal(response.body.company, 'BluePeak Studio');
});

test('GET /api/leads supports filtering', async () => {
  await request(app).post('/api/leads').send({
    name: 'Taylor Gray',
    company: 'Oak & Pine',
    email: 'taylor@oakpine.example',
    source: 'Referral',
    status: 'Qualified',
    notes: 'Needs a proposal.'
  });

  const response = await request(app).get('/api/leads').query({ status: 'Qualified' });
  assert.equal(response.status, 200);
  assert.ok(response.body.some((lead) => lead.name === 'Taylor Gray'));
});

test('POST /api/tasks creates a linked task', async () => {
  const leadResponse = await request(app)
    .post('/api/leads')
    .send({
      name: 'Casey Bell',
      company: 'North Harbor',
      source: 'Referral',
      status: 'Contacted',
      email: 'casey@northharbor.example'
    });

  const response = await request(app)
    .post('/api/tasks')
    .send({
      lead_id: leadResponse.body.id,
      title: 'Send proposal follow-up',
      due_date: '2026-11-12',
      completed: false
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.title, 'Send proposal follow-up');
  assert.equal(response.body.lead_id, leadResponse.body.id);
});

test('DELETE /api/leads/:id removes the lead and its tasks', async () => {
  const leadResponse = await request(app)
    .post('/api/leads')
    .send({
      name: 'Morgan Price',
      company: 'Silverline',
      source: 'Website',
      status: 'New'
    });

  await request(app)
    .post('/api/tasks')
    .send({
      lead_id: leadResponse.body.id,
      title: 'Check pricing questions',
      completed: false
    });

  const deleteResponse = await request(app).delete(`/api/leads/${leadResponse.body.id}`);
  assert.equal(deleteResponse.status, 200);

  const listResponse = await request(app).get('/api/leads');
  assert.equal(listResponse.body.some((lead) => lead.id === leadResponse.body.id), false);
});
