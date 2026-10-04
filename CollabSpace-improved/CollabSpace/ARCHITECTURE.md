# CollabSpace Architecture

```text
 React (Vite)                       Node + Express                    MySQL
 ┌──────────────────┐   REST      ┌────────────────────┐   SQL    ┌─────────────┐
 │ WorkspaceContext │────────────▶│ routes + validation │────────▶│ members     │
 │  (shared state)  │◀────────────│ version check (409) │         │ projects    │
 │ Dashboard/Board/ │             │ lock check (423)    │         │ tasks       │
 │ TaskDetail pages │             └─────────┬──────────┘         │ comments    │
 │                  │   WebSocket           │ broadcast()        │ attachments │
 │                  │◀══════════════════════╧════════════════    │ activity_log│
 └──────────────────┘   presence, locks, task/comment events     └─────────────┘
```

## One change, end to end

1. User saves a task → `PATCH /api/tasks/:id` with `expected_version`.
2. Server checks the edit lock (423 if someone else holds it).
3. `UPDATE ... WHERE id = ? AND version = ?` → 0 rows means stale → 409 + latest copy.
4. On success: `version + 1`, activity row written, `task.updated` broadcast to every tab.
5. Each tab's `WorkspaceContext` applies the event (older versions never overwrite newer ones).

## Where things live

- `backend/src/server.js`: REST API, validation, uploads, activity log
- `backend/src/realtime.js`: WebSocket server, presence, edit locks
- `backend/schema.sql`: tables (idempotent), `npm run db:init` applies it
- `frontend/src/context/WorkspaceContext.jsx`: all shared state and live-event handling
- `frontend/src/pages/`: Dashboard, Projects, ProjectBoard, TaskDetail
