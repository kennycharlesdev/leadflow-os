# LeadFlow OS Architecture

## Overview

LeadFlow OS is a beginner-friendly CRM built with Node.js, Express, SQLite, and vanilla HTML/CSS/JavaScript.

## High-level components

### Application server

The Express app manages API routes, validation, security middleware, and sessions.

### Database layer

`src/db.js` centralizes SQLite schema creation, seed data, CRUD logic, and migration safety.

### Frontend UI

The `public/` folder contains the HTML and JavaScript used to render the dashboard, lead lists, task panels, and forms.

## Data model

- `leads`: contact records, statuses, notes, and timestamps
- `tasks`: follow-ups linked by `lead_id`
- `users`: local auth users and roles
- `organizations`: grouping for demo organizations
- `workflow_events`: lightweight event logging foundation

## Key design goals

- Keep the app understandable for new developers
- Separate the UI from database logic
- Use parameterized SQL and validation to reduce common mistakes
- Keep the data set small and fictional for safe local experimentation
