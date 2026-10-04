-- CollabSpace schema. Safe to run more than once (nothing is dropped, seed data only inserted when empty).
CREATE DATABASE IF NOT EXISTS collabspace;
USE collabspace;

CREATE TABLE IF NOT EXISTS members (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255) UNIQUE,
  avatar_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  deadline DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  assignee_id INT NULL,
  status ENUM('todo','in_progress','done') NOT NULL DEFAULT 'todo',
  priority ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  due_date DATE NULL,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tasks_project (project_id),
  INDEX idx_tasks_assignee (assignee_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (assignee_id) REFERENCES members(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT NOT NULL,
  member_id INT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_comments_task (task_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT NOT NULL,
  member_id INT NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_url VARCHAR(1000) NOT NULL,
  file_size INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_attachments_task (task_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id INT NULL,
  task_id INT NULL,
  member_id INT NULL,
  action VARCHAR(60) NOT NULL,
  detail VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_activity_created (created_at)
);

-- Seed data (only when tables are empty)
INSERT INTO members (name, email)
SELECT * FROM (
  SELECT 'Sai' AS name, 'sai@example.com' AS email UNION ALL
  SELECT 'Ramya', 'ramya@example.com' UNION ALL
  SELECT 'Arjun', 'arjun@example.com'
) AS seed WHERE NOT EXISTS (SELECT 1 FROM members);

INSERT INTO projects (name, description, deadline)
SELECT 'ALGOTHON Collaborative Workspace', 'Build the real-time project collaboration workspace.', '2026-10-30'
WHERE NOT EXISTS (SELECT 1 FROM projects);

INSERT INTO tasks (project_id, title, description, assignee_id, status, priority, due_date)
SELECT * FROM (
  SELECT 1 AS project_id, 'Build dashboard' AS title, 'Create the project overview dashboard.' AS description, 1 AS assignee_id, 'in_progress' AS status, 'high' AS priority, '2026-10-10' AS due_date UNION ALL
  SELECT 1, 'Task board', 'Implement task creation, assignment and status changes.', 2, 'todo', 'medium', '2026-10-15' UNION ALL
  SELECT 1, 'Real-time sync', 'Connect WebSocket events for collaborative updates.', 3, 'todo', 'high', '2026-10-20'
) AS seed WHERE NOT EXISTS (SELECT 1 FROM tasks);
