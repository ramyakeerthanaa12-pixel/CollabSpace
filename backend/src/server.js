import http from "http";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";

import { pool } from "./db.js";
import { attachRealtime, broadcast, getLock } from "./realtime.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, "../uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const STATUSES = ["todo", "in_progress", "done"];
const PRIORITIES = ["low", "medium", "high"];

const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));
app.use(express.json({ limit: "1mb" }));
app.use("/uploads", express.static(uploadDir));

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) =>
      cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).slice(0, 10)}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Lets async route handlers throw; errors go to the handler at the bottom instead of crashing Node.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });
const actorId = (req) => Number(req.get("x-member-id")) || null;
const emptyToNull = (v) => (v === "" || v === undefined ? null : v);

// ---------- helpers ----------
async function getTask(id) {
  const [rows] = await pool.execute(
    `SELECT t.*, m.name AS assignee_name, p.name AS project_name
       FROM tasks t
       LEFT JOIN members m ON m.id = t.assignee_id
       JOIN projects p ON p.id = t.project_id
      WHERE t.id = ?`, [id]);
  return rows[0] || null;
}

async function logActivity({ projectId = null, taskId = null, memberId = null, action, detail = "" }) {
  const [result] = await pool.execute(
    "INSERT INTO activity_log (project_id, task_id, member_id, action, detail) VALUES (?, ?, ?, ?, ?)",
    [projectId, taskId, memberId, action, detail.slice(0, 500)]);
  const [rows] = await pool.execute(
    `SELECT a.*, m.name AS member_name FROM activity_log a
       LEFT JOIN members m ON m.id = a.member_id WHERE a.id = ?`, [result.insertId]);
  broadcast({ type: "activity.created", activity: rows[0] });
}

// ---------- health & members ----------
app.get("/api/health", wrap(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, database: "connected" });
}));

app.get("/api/members", wrap(async (_req, res) => {
  const [rows] = await pool.query("SELECT id, name, email FROM members ORDER BY name");
  res.json(rows);
}));

// ---------- projects ----------
app.get("/api/projects", wrap(async (_req, res) => {
  const [rows] = await pool.query(`
    SELECT p.id, p.name, p.description, p.deadline, p.created_at,
           COUNT(t.id) AS task_count,
           COALESCE(SUM(t.status = 'done'), 0) AS completed_tasks
      FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
     GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC`);
  res.json(rows);
}));

app.post("/api/projects", wrap(async (req, res) => {
  const { name, description = "", deadline } = req.body;
  if (!name?.trim()) throw httpError(400, "Project name is required");
  const [result] = await pool.execute(
    "INSERT INTO projects (name, description, deadline) VALUES (?, ?, ?)",
    [name.trim(), description, emptyToNull(deadline)]);
  const [rows] = await pool.execute(
    "SELECT p.*, 0 AS task_count, 0 AS completed_tasks FROM projects p WHERE id = ?", [result.insertId]);
  broadcast({ type: "project.created", project: rows[0] });
  await logActivity({ projectId: result.insertId, memberId: actorId(req), action: "project.created", detail: `created project "${name.trim()}"` });
  res.status(201).json(rows[0]);
}));

// ---------- tasks ----------
app.get("/api/tasks", wrap(async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT t.*, m.name AS assignee_name, p.name AS project_name
       FROM tasks t LEFT JOIN members m ON m.id = t.assignee_id JOIN projects p ON p.id = t.project_id
      ORDER BY t.due_date IS NULL, t.due_date, t.id`);
  res.json(rows);
}));

app.get("/api/projects/:projectId/tasks", wrap(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT t.*, m.name AS assignee_name, p.name AS project_name
       FROM tasks t LEFT JOIN members m ON m.id = t.assignee_id JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ? ORDER BY t.due_date IS NULL, t.due_date, t.id`, [req.params.projectId]);
  res.json(rows);
}));

app.post("/api/projects/:projectId/tasks", wrap(async (req, res) => {
  const { title, description = "", assignee_id, status = "todo", priority = "medium", due_date } = req.body;
  if (!title?.trim()) throw httpError(400, "Task title is required");
  if (!STATUSES.includes(status)) throw httpError(400, "Invalid status");
  if (!PRIORITIES.includes(priority)) throw httpError(400, "Invalid priority");

  const [project] = await pool.execute("SELECT id FROM projects WHERE id = ?", [req.params.projectId]);
  if (!project[0]) throw httpError(404, "Project not found");

  const [result] = await pool.execute(
    `INSERT INTO tasks (project_id, title, description, assignee_id, status, priority, due_date, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [req.params.projectId, title.trim(), description, emptyToNull(assignee_id), status, priority, emptyToNull(due_date)]);
  const task = await getTask(result.insertId);
  broadcast({ type: "task.created", task });
  await logActivity({ projectId: task.project_id, taskId: task.id, memberId: actorId(req), action: "task.created", detail: `created task "${task.title}"` });
  res.status(201).json(task);
}));

app.get("/api/tasks/:taskId", wrap(async (req, res) => {
  const task = await getTask(req.params.taskId);
  if (!task) throw httpError(404, "Task not found");
  res.json(task);
}));

/*
  SIMULTANEOUS-EDIT PROTECTION (two layers)
  1. Soft lock (WebSocket): while someone is editing, others see "X is editing" and can't start editing.
     The REST API also refuses changes from anyone else while the lock is held (HTTP 423).
  2. Optimistic concurrency: the client sends the version it last read. The UPDATE only matches if the
     version is still the same, otherwise HTTP 409 + the latest copy, so nothing is silently overwritten.
*/
app.patch("/api/tasks/:taskId", wrap(async (req, res) => {
  const { expected_version } = req.body;
  if (!Number.isInteger(expected_version)) throw httpError(400, "expected_version is required");

  const sets = [];
  const values = [];
  const set = (column, value) => { sets.push(`${column} = ?`); values.push(value); };

  // "in body" (not COALESCE) so a field can be deliberately cleared, e.g. unassign or remove a deadline.
  if ("title" in req.body) {
    if (!req.body.title?.trim()) throw httpError(400, "Task title cannot be empty");
    set("title", req.body.title.trim());
  }
  if ("description" in req.body) set("description", req.body.description ?? "");
  if ("assignee_id" in req.body) set("assignee_id", emptyToNull(req.body.assignee_id));
  if ("due_date" in req.body) set("due_date", emptyToNull(req.body.due_date));
  if ("status" in req.body) {
    if (!STATUSES.includes(req.body.status)) throw httpError(400, "Invalid status");
    set("status", req.body.status);
  }
  if ("priority" in req.body) {
    if (!PRIORITIES.includes(req.body.priority)) throw httpError(400, "Invalid priority");
    set("priority", req.body.priority);
  }
  if (!sets.length) throw httpError(400, "Nothing to update");

  const me = actorId(req);
  const lock = getLock(req.params.taskId);
  if (lock && lock.memberId !== me) {
    throw httpError(423, `${lock.name} is editing this task right now.`, { locked_by: lock.name });
  }

  const [result] = await pool.execute(
    `UPDATE tasks SET ${sets.join(", ")}, version = version + 1 WHERE id = ? AND version = ?`,
    [...values, req.params.taskId, expected_version]);

  if (result.affectedRows === 0) {
    const current = await getTask(req.params.taskId);
    if (!current) throw httpError(404, "Task not found");
    throw httpError(409, "Task was changed by another user.", { conflict: true, current });
  }

  const task = await getTask(req.params.taskId);
  broadcast({ type: "task.updated", task, by: me });
  const changed = Object.keys(req.body).filter((k) => k !== "expected_version").join(", ");
  await logActivity({ projectId: task.project_id, taskId: task.id, memberId: me, action: "task.updated", detail: `updated ${changed} on "${task.title}"` });
  res.json(task);
}));

app.delete("/api/tasks/:taskId", wrap(async (req, res) => {
  const task = await getTask(req.params.taskId);
  if (!task) throw httpError(404, "Task not found");
  await pool.execute("DELETE FROM tasks WHERE id = ?", [task.id]);
  broadcast({ type: "task.deleted", taskId: task.id, projectId: task.project_id });
  await logActivity({ projectId: task.project_id, memberId: actorId(req), action: "task.deleted", detail: `deleted task "${task.title}"` });
  res.status(204).end();
}));

// ---------- comments ----------
app.get("/api/tasks/:taskId/comments", wrap(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT c.*, m.name AS member_name FROM comments c JOIN members m ON m.id = c.member_id
      WHERE c.task_id = ? ORDER BY c.created_at, c.id`, [req.params.taskId]);
  res.json(rows);
}));

app.post("/api/tasks/:taskId/comments", wrap(async (req, res) => {
  const { member_id, body } = req.body;
  if (!member_id || !body?.trim()) throw httpError(400, "member_id and comment body are required");
  const task = await getTask(req.params.taskId);
  if (!task) throw httpError(404, "Task not found");

  const [result] = await pool.execute(
    "INSERT INTO comments (task_id, member_id, body) VALUES (?, ?, ?)", [task.id, member_id, body.trim()]);
  const [rows] = await pool.execute(
    `SELECT c.*, m.name AS member_name FROM comments c JOIN members m ON m.id = c.member_id WHERE c.id = ?`,
    [result.insertId]);
  broadcast({ type: "comment.created", comment: rows[0] });
  await logActivity({ projectId: task.project_id, taskId: task.id, memberId: member_id, action: "comment.created", detail: `commented on "${task.title}"` });
  res.status(201).json(rows[0]);
}));

// ---------- attachments ----------
app.get("/api/tasks/:taskId/attachments", wrap(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT a.*, m.name AS member_name FROM attachments a JOIN members m ON m.id = a.member_id
      WHERE a.task_id = ? ORDER BY a.created_at DESC, a.id DESC`, [req.params.taskId]);
  res.json(rows);
}));

app.post("/api/tasks/:taskId/attachments", upload.single("file"), wrap(async (req, res) => {
  const member = actorId(req);
  const task = await getTask(req.params.taskId);
  if (!req.file) throw httpError(400, "No file received");
  if (!task || !member) {
    fs.unlink(req.file.path, () => {});
    throw httpError(task ? 400 : 404, task ? "x-member-id header is required" : "Task not found");
  }
  const [result] = await pool.execute(
    "INSERT INTO attachments (task_id, member_id, file_name, file_url, file_size) VALUES (?, ?, ?, ?, ?)",
    [task.id, member, req.file.originalname.slice(0, 255), `/uploads/${req.file.filename}`, req.file.size]);
  const [rows] = await pool.execute(
    `SELECT a.*, m.name AS member_name FROM attachments a JOIN members m ON m.id = a.member_id WHERE a.id = ?`,
    [result.insertId]);
  broadcast({ type: "attachment.created", attachment: rows[0] });
  await logActivity({ projectId: task.project_id, taskId: task.id, memberId: member, action: "attachment.created", detail: `attached ${rows[0].file_name} to "${task.title}"` });
  res.status(201).json(rows[0]);
}));

app.delete("/api/attachments/:id", wrap(async (req, res) => {
  const [rows] = await pool.execute("SELECT * FROM attachments WHERE id = ?", [req.params.id]);
  if (!rows[0]) throw httpError(404, "Attachment not found");
  await pool.execute("DELETE FROM attachments WHERE id = ?", [rows[0].id]);
  fs.unlink(path.join(uploadDir, path.basename(rows[0].file_url)), () => {});
  broadcast({ type: "attachment.deleted", attachmentId: rows[0].id, taskId: rows[0].task_id });
  res.status(204).end();
}));

// ---------- activity feed ----------
app.get("/api/activity", wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 15, 50);
  const [rows] = await pool.query(
    `SELECT a.*, m.name AS member_name FROM activity_log a LEFT JOIN members m ON m.id = a.member_id
      ORDER BY a.id DESC LIMIT ${limit}`);
  res.json(rows);
}));

// ---------- errors ----------
app.use((req, res) => res.status(404).json({ message: `No route for ${req.method} ${req.path}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.status) return res.status(err.status).json({ message: err.message, ...err.extra });
  if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "File is larger than 10 MB" });
  if (err.code === "ER_NO_REFERENCED_ROW_2") return res.status(400).json({ message: "Referenced member/project does not exist" });
  console.error(err);
  res.status(500).json({ message: "Something went wrong on the server" });
});

const server = http.createServer(app);
attachRealtime(server);

const port = Number(process.env.PORT || 5000);
server.listen(port, () => console.log(`CollabSpace API + WebSocket running on http://localhost:${port}`));
