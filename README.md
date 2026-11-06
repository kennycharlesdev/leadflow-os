# LeadFlow OS

LeadFlow OS is a beginner-friendly lead management dashboard built with Node.js, Express, and SQLite. It helps you track leads, review workflow status, and manage follow-up tasks from one simple interface.

## What this project includes

- Responsive dashboard with summary cards
- CRUD workflow for leads
- Search and status filtering
- Follow-up task tracking with due dates
- SQLite database with seed data for fictional sample leads only
- REST API endpoints for leads, tasks, and dashboard stats
- Basic validation and error handling

## Project structure

- `server.js` — application entry point
- `src/app.js` — Express app and API routes
- `src/db.js` — SQLite schema, database access, and seed data
- `public/` — frontend HTML, CSS, and JavaScript
- `tests/` — automated API tests
- `data/` — SQLite database folder

## Installation

1. Open the project folder in VS Code.
2. Install dependencies:

```bash
npm install
```

3. Copy the example environment file:

```bash
cp .env.example .env
```

## Start the app

```bash
npm start
```

Open:

```text
http://localhost:3000
```

## Development mode

```bash
npm run dev
```

## Testing

```bash
npm test
```

## API overview

### Dashboard

- `GET /api/dashboard` — summary totals for leads and tasks

### Leads

- `GET /api/leads` — list leads with optional filters
- `POST /api/leads` — create a new lead
- `GET /api/leads/:id` — view one lead
- `PUT /api/leads/:id` — update a lead
- `DELETE /api/leads/:id` — delete a lead and its related tasks

### Tasks

- `GET /api/tasks` — list tasks
- `POST /api/tasks` — create a follow-up task
- `PUT /api/tasks/:id` — update a task
- `DELETE /api/tasks/:id` — delete a task

## Database schema

### `leads`

- `id` — integer primary key
- `name` — lead contact name
- `company` — company name
- `email` — optional email
- `phone` — optional phone number
- `source` — referral, website, LinkedIn, etc.
- `status` — `New`, `Contacted`, `Qualified`, `Won`, or `Lost`
- `notes` — freeform notes
- `created_at` — timestamp

### `tasks`

- `id` — integer primary key
- `lead_id` — linked lead id
- `title` — task summary
- `due_date` — optional due date
- `completed` — 0 or 1 boolean value
- `created_at` — timestamp

## Security and authentication foundation

The current sprint branch adds a more robust local authentication foundation and tighter request validation:

- password hashing with bcrypt
- session-based auth for protected routes
- registration and login endpoints
- admin role checks for internal management endpoints
- stricter lead and task validation
- CORS restrictions, security headers, and rate limiting

## Notes

- The sample data is fictional and meant for local learning only.
- This project is not production-ready and should not store real customer data.
- It is a beginner-friendly starting point for learning Express, SQLite, and API-driven app design.
