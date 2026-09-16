/**
 * รัน SQL migration ตามลำดับไฟล์ใน db/migrations
 *
 *   npm run migrate            → แค่แสดงว่าจะรันอะไรบ้าง (ไม่แตะฐานข้อมูล)
 *   npm run migrate -- --apply → รันจริง
 *   DB_SCHEMA=bot_test npm run migrate -- --apply → รันลง schema สำหรับเทส
 *
 * เขียนเป็น .mjs เพื่อให้รันด้วย node ตรง ๆ ได้โดยไม่ต้องมีตัวแปลง TypeScript
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]*$/;

const apply = process.argv.includes("--apply");
const schema = (process.env.DB_SCHEMA ?? "public").trim();
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("ไม่พบ DATABASE_URL (ลองรันผ่าน npm run migrate ซึ่งอ่านจาก .env.local)");
  process.exit(1);
}

if (!SCHEMA_PATTERN.test(schema)) {
  console.error(`DB_SCHEMA ไม่ถูกต้อง: ต้องเป็นตัวพิมพ์เล็ก a-z, 0-9 และ _ เท่านั้น`);
  process.exit(1);
}

const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
if (files.length === 0) {
  console.log("ไม่มีไฟล์ migration");
  process.exit(0);
}

const sql = postgres(databaseUrl, {
  prepare: false,
  max: 1,
  connect_timeout: 15,
  idle_timeout: 2,
  connection: { application_name: "badminton-migrate", search_path: schema },
  // NOTICE อย่าง "schema already exists, skipping" ไม่ใช่ error ไม่ต้องรก output
  onnotice: () => {},
});

try {
  const [{ exists }] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = 'schema_migrations'
    ) AS exists
  `;

  const applied = exists
    ? (await sql`SELECT name FROM schema_migrations`).map((row) => row.name)
    : [];

  const pending = files.filter((name) => !applied.includes(name));

  console.log(`schema: ${schema}`);
  console.log(`รันไปแล้ว ${applied.length} ไฟล์ | ค้างอยู่ ${pending.length} ไฟล์`);

  if (pending.length === 0) {
    console.log("ไม่มีอะไรต้องรัน");
  } else if (!apply) {
    console.log("\nไฟล์ที่จะรัน (ยังไม่ได้รันจริง ต้องใส่ --apply):");
    for (const name of pending) console.log(`  - ${name}`);
    console.log("\nดู SQL ทั้งหมดได้ใน db/migrations/");
  } else {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    for (const name of pending) {
      // ใช้ path.join ไม่ใช่ URL เพราะ MIGRATIONS_DIR ถูก decode แล้ว
      // ถ้า path มีช่องว่างหรืออักษรไทยจะประกอบ URL ผิด
      const statements = await readFile(join(MIGRATIONS_DIR, name), "utf8");
      // ทั้งไฟล์ + การบันทึกว่ารันแล้ว อยู่ใน transaction เดียวกัน ถ้าพังกลางทางจะไม่ค้างครึ่ง ๆ
      await sql.begin(async (tx) => {
        await tx.unsafe(statements);
        await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
      });
      console.log(`  ✔ ${name}`);
    }
    console.log("\nรัน migration เรียบร้อย");
  }
} catch (error) {
  console.error("migration ล้มเหลว:", error.code ?? "", error.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
