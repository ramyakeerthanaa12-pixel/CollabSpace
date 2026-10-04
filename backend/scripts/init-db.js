// Runs schema.sql using the credentials in .env  ->  npm run db:init
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

const sql = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../schema.sql"), "utf8");
const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  multipleStatements: true
});
await conn.query(sql);
await conn.end();
console.log("Database ready: collabspace");
