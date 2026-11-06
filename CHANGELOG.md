# Changelog

## Unreleased

- Hardened the database initializer to prevent duplicate-column migration failures during app restarts.
- Added a local auth foundation with registration, login, logout, session handling, and protected admin routes.
- Added stricter validation for lead and task payloads.
- Added security headers, CORS restrictions, and rate limiting.
- Added automated API regression tests for auth and validation.

## V0.1.0

- Initial LeadFlow OS CRM MVP with leads, follow-up tasks, dashboard stats, search/filter, and SQLite persistence.
