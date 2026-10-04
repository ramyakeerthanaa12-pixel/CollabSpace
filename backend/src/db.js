import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "collabspace",
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: ["DATE"], // DATE columns stay "2026-10-10" (no timezone shifting)
  timezone: "Z"
});

// Keep every connection in UTC so timestamps are consistent for all users.
pool.pool.on("connection", (conn) => conn.query("SET time_zone = '+00:00'"));
