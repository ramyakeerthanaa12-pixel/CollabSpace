# CollabSpace — Collaborative Project Workspace (ALG-WEB-01)

Real-time project workspace: projects, tasks, comments, file attachments, live updates, and
protection against simultaneous edits.

**Stack:** React (Vite) · Node.js + Express · MySQL · WebSocket (`ws`)

## Quick start

Needs Node.js 18+ and MySQL 8+.

```bash
# 1. Backend
cd backend
npm install
cp .env.example .env        # then put your MySQL password in .env
npm run db:init             # creates the database, tables and sample data (safe to re-run)
npm run dev                 # API + WebSocket on http://localhost:5000

# 2. Frontend (second terminal)
cd frontend
npm install
npm run dev                 # http://localhost:5173
```

Check the backend: http://localhost:5000/api/health

## Features

| Area | What it does |
|---|---|
| Projects | Create projects, live progress bars computed from tasks |
| Task board | Kanban columns, drag and drop to change status, search, filter by assignee |
| Tasks | Title, description, priority, assignee, deadline, edit, delete |
| Comments | Per-task comments with author names, appear live for everyone |
| Files | Real uploads (max 10 MB), download, delete |
| Dashboard | Stats, overdue count, upcoming deadlines, live activity feed |
| Presence | See who is online |
| Members | "Signed in as" switcher (each browser tab is its own user) |

## Real-time updates

Every create, update, delete, comment and upload is saved to MySQL by the REST API, then broadcast
over WebSocket. Open the app in two tabs, pick different users, and changes appear instantly in both.
The client reconnects automatically and re-syncs if the connection drops.

## Simultaneous-edit protection (bonus)

Three layers, so one person can never silently overwrite another:

1. **Edit lock (WebSocket).** Clicking *Edit details* takes a lock on that task. Everyone else sees
   "Sai is editing" on the board and the task page, and their Edit button is disabled. The lock is
   released on save, cancel, closing the tab, or after 45 s without a heartbeat. The REST API also
   rejects writes from other users while the lock is held (HTTP 423).
2. **Version check (optimistic concurrency).** Every task has a `version`. Saves send the version
   the user last saw and the SQL is `UPDATE ... WHERE id = ? AND version = ?`. If someone else saved
   first, the server answers HTTP 409 with the latest copy.
3. **Smart conflict resolution.** Only the fields you changed are sent. If the other person edited
   *different* fields, the save is merged automatically. If you both changed the *same* field, a dialog
   shows "Yours vs Theirs" and you choose: keep mine, use theirs, or keep editing.

### Demo script (1 minute)

1. Open two tabs. Tab 1 = Sai, Tab 2 = Ramya (use the "Signed in as" menu).
2. Tab 1: open a task and click **Edit details**. Tab 2 instantly shows "Sai is editing" and blocks editing.
3. Tab 1: save. Tab 2 sees the new values live.
4. To show the version check: in both tabs change the **Status** dropdown on the same task at nearly the
   same time. The slower one gets a clear "Someone updated this task first" message instead of overwriting.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | DB check |
| GET | `/api/members` | |
| GET / POST | `/api/projects` | |
| GET | `/api/tasks` | all tasks (dashboard) |
| GET / POST | `/api/projects/:id/tasks` | |
| GET / PATCH / DELETE | `/api/tasks/:id` | PATCH needs `expected_version`; 409 stale, 423 locked |
| GET / POST | `/api/tasks/:id/comments` | |
| GET / POST | `/api/tasks/:id/attachments` | POST is multipart, field `file` |
| DELETE | `/api/attachments/:id` | |
| GET | `/api/activity` | latest activity |

The frontend sends an `x-member-id` header so the server knows who made each change.

WebSocket messages from client: `hello`, `lock.acquire`, `lock.refresh`, `lock.release`.
From server: `presence`, `locks.snapshot`, `lock.acquired/released/granted/denied`, `task.created/updated/deleted`,
`comment.created`, `attachment.created/deleted`, `project.created`, `activity.created`.

## Deployment

Frontend env: `VITE_API_URL=https://YOUR-BACKEND/api`, `VITE_WS_URL=wss://YOUR-BACKEND`
Backend env: `CLIENT_ORIGIN`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
Uploaded files live in `backend/uploads`; on hosts with temporary disks, attach persistent storage.

## Known limits / next steps

- No passwords: the member switcher is a demo identity. Real login (JWT) is the next step.
- Edit locks live in server memory, so run a single backend instance (use Redis to scale out).
- Events are broadcast to all connected clients rather than scoped per project.
