# 🏸 Badminton LINE Bot

LINE Bot สำหรับจัดรอบตีแบดใน LINE Group

- Spec: `Badminton LINE Bot — MVP Specification.md`
- LLM: `LLM Design.md`
- กฎโปรเจค: `CLAUDE.md`

## สถานะ

ไล่ตามลำดับใน spec §29

- [x] 1–4 Next.js + Webhook + ตรวจ LINE signature + Wake word `บอทจ๋า`
- [x] Deploy ขึ้น Vercel และต่อกับ LINE จริงแล้ว (ทดสอบในกลุ่มผ่าน 2026-09-16)
- [x] 5 PostgreSQL (Supabase) + postgres.js + SQL migrations
- [x] 6 สร้าง user จากโปรไฟล์ LINE
- [x] 7 เปิดรอบตี (`บอทจ๋า เปิดตี` → เลือกคอร์ท/วัน/เวลา/ชั่วโมง → ยืนยัน)
- [x] 8–10 ลงชื่อ / ถอนชื่อ / ดูรายชื่อ
- [ ] 11–13 Edit / Cancel / Close ← **ทำต่อจากนี้**
- [ ] 14–15 LINE Flex + Router ส่วนที่เหลือ (spec §18)
- [ ] 16–19 Gemini + Tools + Session + Fallback

พฤติกรรมตอนนี้:

| เหตุการณ์ | บอททำอะไร |
|---|---|
| ถูกเชิญเข้ากลุ่ม | ทักทายและบอกวิธีเริ่ม |
| ในกลุ่ม พิมพ์ `บอทจ๋า เปิดตี` | ถามจำนวนคอร์ท → วัน → เวลา → ชั่วโมง → การ์ดยืนยัน |
| `บอทจ๋า ลงชื่อ` หรือกดปุ่ม 🙋 | ลงชื่อแล้วส่งการ์ดพร้อมจำนวนคนล่าสุด |
| `บอทจ๋า ถอนชื่อ` หรือกดปุ่ม ❌ | ถอนชื่อแล้วส่งการ์ดใหม่ (ลงกลับเข้ามาใหม่ได้) |
| `บอทจ๋า ใครตีบ้าง` / `รายชื่อ` หรือกดปุ่ม 👀 | รายชื่อเรียงตามลำดับที่ลงชื่อ |
| ในกลุ่ม พิมพ์ `บอทจ๋า ...` อย่างอื่น | ยังไม่ตอบ (รอคำสั่งที่เหลือและ LLM) |
| ในกลุ่ม ข้อความที่ไม่มี wake word | ไม่ตอบ |
| แชท 1:1 หรือห้องแบบอื่น พิมพ์ `บอทจ๋า ...` | ตอบว่าใช้ได้ในกลุ่มเท่านั้น |

กติกาของปุ่ม: เฉพาะคนที่สั่งเท่านั้นที่กดได้ ใช้ได้ครั้งเดียว และหมดอายุใน 10 นาที

ทดสอบว่า webhook ต่อติดจริงได้ 2 ทาง คือเชิญบอทเข้ากลุ่มใหม่ หรือทักบอทในแชท 1:1 ด้วย `บอทจ๋า`

## HTTP ที่ webhook ตอบ

| สถานะ | เมื่อไหร่ |
|---|---|
| 200 | signature ถูกต้อง (รวมกรณี event พังบางอัน ซึ่งจะ log แล้วข้าม) |
| 401 | ไม่มี header `x-line-signature` หรือ signature ไม่ตรง |
| 503 | env ของ LINE ไม่ครบหรือรูปแบบผิด — ปุ่ม Verify ของ LINE จะไม่ผ่าน จะได้รู้ตัวก่อนใช้งานจริง |
| 413 / 408 / 400 | body ใหญ่เกิน 1 MB / อ่าน body ไม่จบใน 10 วินาที / อ่าน body ไม่สำเร็จ |

## Local Development

ต้องมี Node.js 22.12 ขึ้นไป (ตาม vitest 5 และ Next 16)

```bash
npm install
cp .env.example .env.local   # ใส่ LINE_CHANNEL_SECRET และ LINE_CHANNEL_ACCESS_TOKEN
npm run dev                  # http://localhost:3000/api/line/webhook
```

| คำสั่ง | ใช้ทำ |
|---|---|
| `npm run dev` | รัน dev server |
| `npm test` | รัน tests (ไม่เรียก LINE API และไม่ต่อฐานข้อมูลจริง) |
| `npm run typecheck` | ตรวจ TypeScript |
| `npm run build` | build production |
| `npm run migrate` | ดูว่ามี migration ค้างกี่ไฟล์ (ไม่แตะฐานข้อมูล) |
| `npm run migrate -- --apply` | รัน migration จริงลง schema `public` |
| `npm run migrate:test -- --apply` | รัน migration ลง schema `bot_test` |
| `npm run test:db` | รัน tests ที่ต่อฐานข้อมูลจริง (schema `bot_test`) |

ทดสอบ webhook กับ LINE จริงจากเครื่องตัวเอง ต้องเปิด tunnel (เช่น ngrok) แล้วเอา URL ไปใส่ใน LINE Console ชั่วคราว

## Environment Variables

| ชื่อ | ใช้ตอนนี้ |
|---|---|
| `LINE_CHANNEL_SECRET` | ✅ ตรวจ signature |
| `LINE_CHANNEL_ACCESS_TOKEN` | ✅ ส่ง reply |
| `DATABASE_URL` | ✅ ต่อ Supabase (transaction pooler port 6543) |
| `DB_SCHEMA` | ไม่บังคับ ค่าเริ่มต้น `public` ใช้ `bot_test` ตอนรันเทส |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | ยังไม่ใช้ |

ห้าม commit ค่าจริง ใส่ใน `.env.local` (ถูก gitignore ไว้แล้ว) และใน Vercel เท่านั้น

## Deploy (Vercel)

Deploy อัตโนมัติจาก branch `main` ของ GitHub

| ค่า | ที่ใช้อยู่ |
|---|---|
| Vercel project | `bot-bad` |
| Webhook URL | `https://bot-bad.vercel.app/api/line/webhook` |
| Node.js version | 22.x (ตาม `engines` ใน package.json) |

ตั้งค่าครั้งแรก:

1. Import repo ใน Vercel แล้วใส่ env `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`
2. LINE Developers Console → Messaging API:
   - Webhook URL → กด **Verify**
   - เปิด **Use webhook** และ **Allow bot to join group chats**
3. LINE Official Account Manager → ตั้งค่า → การตั้งค่าการตอบกลับ:
   - แชท: ปิด
   - ข้อความทักทายเพื่อนใหม่: ปิด
   - ข้อความตอบกลับอัตโนมัติ: ปิด
   - Webhook: เปิด

### เช็กว่า deploy ใช้งานได้ไหม (ไม่ต้องใช้ secret)

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'x-line-signature: AAAA' -H 'content-type: application/json' \
  --data '{"destination":"U1","events":[]}' \
  https://bot-bad.vercel.app/api/line/webhook
```

- `401` = ปกติ env เข้าครบ (signature ปลอมเลยไม่ผ่าน)
- `503` = env ของ LINE ขาดหรือรูปแบบผิด ดู Logs จะมีบรรทัด `[webhook] not configured:` บอกชื่อตัวแปร

## Database

Supabase PostgreSQL ต่อตรงด้วย `postgres` (postgres.js) ไม่ใช้ ORM ตาม spec §20

- connection อยู่ที่ `src/lib/db.ts` ตั้ง `prepare: false` เพราะ transaction pooler ไม่รองรับ prepared statement
- เลือก schema ด้วย startup parameter `search_path` (ทดสอบแล้วว่า pooler ของ Supabase รองรับ)
- SQL ทั้งหมดอยู่ใน `src/repositories/` เท่านั้น

### Migration

ไฟล์ SQL เรียงตามลำดับใน `db/migrations/` และจดว่ารันอะไรไปแล้วในตาราง `schema_migrations`

```bash
npm run migrate                 # ดูรายการที่ค้าง ไม่แตะฐานข้อมูล
npm run migrate -- --apply      # รันจริงลง public
npm run migrate:test -- --apply # รันลง schema bot_test สำหรับเทส
```

แต่ละไฟล์รันอยู่ใน transaction เดียวพร้อมการบันทึกลง `schema_migrations` ถ้าพังกลางทางจะไม่ค้างครึ่ง ๆ

ตาราง (รายละเอียดใน spec §20): `users`, `games`, `game_players`, `pending_actions`, `conversation_sessions`

### Tests ที่ต่อฐานข้อมูล

อยู่ใน `tests/db/` และจะถูกข้ามอัตโนมัติถ้าไม่ได้ตั้ง `DB_SCHEMA=bot_test`
เทสพวกนี้อ่านค่าจาก `.env.local` เองและลบข้อมูลที่สร้างขึ้นหลังรันเสร็จ

หมายเหตุ: โปรเจค Supabase แบบ Free จะถูก pause เมื่อไม่มีการใช้งานราวหนึ่งสัปดาห์ ต้องเข้าไปกด resume ใน dashboard
