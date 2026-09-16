import postgres from "postgres";
import { getDatabaseSchema, getDatabaseUrl } from "./env";

export type Sql = postgres.Sql<Record<string, never>>;

let client: Sql | null = null;

export function createSql(
  url: string = getDatabaseUrl(),
  schema: string = getDatabaseSchema(),
): Sql {
  return postgres(url, {
    // Supabase Transaction Pooler (port 6543) ไม่รองรับ prepared statement
    prepare: false,
    // serverless: 1 connection ต่อ instance จะได้ไม่กิน connection limit ของ Free tier
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      application_name: "badminton-line-bot",
      // ส่งเป็น startup parameter เพราะ transaction pooler ไม่เก็บค่า SET ข้ามคำสั่ง
      search_path: schema,
    },
  });
}

/** ใช้ตัวเดียวกันทั้ง instance สร้างตอนเรียกครั้งแรก จะได้ build ได้โดยไม่ต้องมี DATABASE_URL */
export function getSql(): Sql {
  if (!client) client = createSql();
  return client;
}

/** ปิด connection ใช้ในเทสหรือสคริปต์ที่ต้องจบการทำงาน */
export async function closeSql(): Promise<void> {
  if (!client) return;
  const current = client;
  client = null;
  await current.end({ timeout: 5 });
}
