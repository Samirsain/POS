// Applies supabase/migrations/*.sql in order. Connection string from DATABASE_URL.
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set"); process.exit(1); }

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
console.log("connected");

for (const file of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort()) {
  process.stdout.write(`${file} ... `);
  await client.query(readFileSync(`supabase/migrations/${file}`, "utf8"));
  console.log("ok");
}

const { rows } = await client.query(`
  select table_name from information_schema.tables
   where table_schema = 'public' order by table_name`);
console.log("tables:", rows.map((r) => r.table_name).join(", "));
const { rows: fns } = await client.query(`
  select routine_name from information_schema.routines
   where routine_schema = 'public' order by routine_name`);
console.log("functions:", fns.map((r) => r.routine_name).join(", "));
await client.end();
