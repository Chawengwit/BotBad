# 🏸 Badminton LINE Bot — MVP Specification

## 1. Project Overview

สร้าง LINE Bot สำหรับจัดการกลุ่มเล่นแบดมินตันใน LINE Group

เป้าหมายของ MVP:

- เปิดรอบตีแบด
- กำหนดจำนวนคอร์ท
- กำหนดวันและเวลา
- ระบบคำนวณจำนวนผู้เล่นสูงสุดตามจำนวนคอร์ท
- สมาชิกลงชื่อ
- สมาชิกถอนชื่อ
- ดูรายชื่อผู้เล่น
- แก้ไขรอบตี
- ยกเลิกรอบตี
- ใช้ LLM ช่วยเข้าใจภาษาธรรมชาติเมื่อจำเป็น
- เน้น Free Tier / ค่าใช้จ่าย $0 ในช่วงทดลอง

---

# 2. Core Concept

Bot ใช้งานใน LINE Group

Bot จะตอบสนองเฉพาะข้อความที่ขึ้นต้นด้วย:

```text
บอทจ๋า
```

ข้อความอื่นทั้งหมดต้องถูก ignore

ตัวอย่าง:

```text
วันนี้ใครตีบ้าง
```

Bot:

```text
ไม่ตอบ
ไม่เรียก LLM
```

แต่:

```text
บอทจ๋า วันนี้ใครตีบ้าง
```

Bot:

```text
ตอบและประมวลผล
```

`บอทจ๋า` คือ Wake Word / Scope Gate ของระบบ

---

# 3. Technology Stack

## Application

- TypeScript
- Next.js
- Next.js App Router
- Next.js Route Handler

## Hosting

- Vercel Hobby

## Database

- Supabase PostgreSQL

## Database Access

- ไม่ใช้ ORM
- ใช้ SQL Query ตรง (Raw SQL) ผ่าน driver `postgres` (postgres.js)
- ทุก query ต้องเป็น parameterized query เท่านั้น
- Migration เป็นไฟล์ `.sql` ธรรมดา

## LINE

- LINE Messaging API
- LINE Webhook

## LLM

- Google Gemini API
- ใช้ Free Tier
- LLM ใช้เฉพาะข้อความที่ต้องตีความภาษาธรรมชาติ

## Source Control

- GitHub

## Package Manager

- npm หรือ pnpm

---

# 4. Architecture

```text
LINE User
    │
    ▼
LINE Messaging API
    │
    │ Webhook
    ▼
Vercel
    │
    ▼
Next.js Route Handler
/api/line/webhook
    │
    ▼
Wake Word Check
    │
    ├── ไม่มี "บอทจ๋า"
    │       └── Ignore
    │
    └── มี "บอทจ๋า"
            │
            ▼
       Command Parser
            │
       ┌────┴─────┐
       │          │
      Rule       LLM
       │          │
       └────┬─────┘
            ▼
         Validate
            ▼
       Game Service
            │
            ▼
      Repository (Raw SQL)
            │
            ▼
      PostgreSQL
            │
            ▼
      LINE Messaging API
```

---

# 5. Important Design Principle

## LLM ไม่ใช่ตัวควบคุมระบบ

LLM มีหน้าที่เพียง:

> แปลงภาษาธรรมชาติของ User → Structured Command

ตัวอย่าง:

User:

```text
บอทจ๋า พรุ่งนี้สองทุ่มเปิดตีให้หน่อย
```

LLM:

```json
{
  "intent": "create_game",
  "date": "tomorrow",
  "time": "20:00"
}
```

จากนั้น Application ต้อง:

1. Validate output
2. Validate business rules
3. เรียก Game Service
4. Database operation

ห้ามให้ LLM เรียก Database โดยตรง

---

# 6. Wake Word Rule

ข้อความต้องขึ้นต้นด้วย:

```text
บอทจ๋า
```

ตัวอย่าง:

```text
บอทจ๋า เปิดตี
```

ผ่าน

```text
บอทจ๋า ลงชื่อ
```

ผ่าน

```text
บอทจ๋า คืนนี้ผมไปตีด้วยนะ
```

ผ่าน

ข้อความเหล่านี้ต้อง ignore:

```text
เปิดตี
ลงชื่อ
คืนนี้ใครตีบ้าง
หวัดดี
```

เมื่อไม่ผ่าน Wake Word:

- ไม่เรียก LLM
- ไม่เรียก Database
- ไม่ส่งข้อความกลับ LINE

---

# 7. Game Rules

## Court

User สามารถเลือกจำนวนคอร์ท:

```text
1
2
3
4
```

## Players

กำหนดจำนวนผู้เล่นตามจำนวนคอร์ท:

```text
1 court = 8 players
2 courts = 16 players
3 courts = 24 players
4 courts = 32 players
```

Formula:

```text
max_players = court_count * 8
```

MVP ไม่ต้องให้ User กำหนด max players เอง

---

# 8. Full-Time Rule

ทุกคนที่ลงชื่อถือว่าเล่นเต็มช่วงเวลาของ Game

ไม่มี:

- เล่นบางช่วง
- จองครึ่งชั่วโมง
- จองเฉพาะบางเวลา

Game มี:

```text
date
start_time
duration
```

ตัวอย่าง:

```text
2026-09-16
19:00
2 hours
```

แสดงเป็น:

```text
19:00 - 21:00
```

---

# 9. Create Game Flow

User:

```text
บอทจ๋า เปิดตี
```

Bot:

```text
🏸 เปิดรอบตีแบด

กี่คอร์ท?
```

Buttons:

```text
[ 1 คอร์ท ]
[ 2 คอร์ท ]
[ 3 คอร์ท ]
[ 4 คอร์ท ]
```

เลือก:

```text
1 คอร์ท
```

Bot:

```text
📅 วันไหน?
```

Buttons:

```text
[ วันนี้ ]
[ พรุ่งนี้ ]
[ เลือกวัน ]
```

จากนั้น:

```text
⏰ กี่โมง?
```

ตัวอย่าง:

```text
[ 18:00 ]
[ 19:00 ]
[ 20:00 ]
[ กำหนดเวลาเอง ]
```

จากนั้น:

```text
⏱️ เล่นกี่ชั่วโมง?
```

ตัวอย่าง:

```text
[ 1 ชั่วโมง ]
[ 2 ชั่วโมง ]
[ 3 ชั่วโมง ]
```

สุดท้าย Bot แสดง Confirmation:

```text
🏸 เปิดตีแบด

📅 พุธ 16 ก.ย.
⏰ 19:00 - 21:00
🏟️ 1 คอร์ท
👥 รับ 8 คน

ยืนยันไหม?

[ ✅ เปิดตี ]
[ ❌ ยกเลิก ]
```

---

# 10. Game Message

เมื่อสร้าง Game สำเร็จ:

```text
🏸 BADMINTON

📅 พุธ 16 ก.ย.
⏰ 19:00 - 21:00
🏟️ 1 คอร์ท
👥 0/8 คน

ยังไม่มีคนลงชื่อ

[ 🙋 ลงชื่อ ]
[ 👀 รายชื่อ ]
```

---

# 11. Join Game

User กด:

```text
🙋 ลงชื่อ
```

ระบบต้อง:

1. Identify LINE User
2. Create user ถ้ายังไม่มี
3. ตรวจว่า Game ยังเปิด
4. ตรวจว่า User ยังไม่ได้ลงชื่อ
5. ตรวจจำนวนผู้เล่น
6. เพิ่ม player
7. Update message

ตัวอย่าง:

```text
🏸 BADMINTON

📅 พุธ 16 ก.ย.
⏰ 19:00 - 21:00
🏟️ 1 คอร์ท
👥 1/8 คน

1. เชวง

[ 🙋 ลงชื่อ ]
[ ❌ ถอนชื่อ ]
[ 👀 รายชื่อ ]
```

---

# 12. Full Game

ถ้า:

```text
8/8
```

Game ถือว่าเต็ม

User คนที่ 9 พยายามลงชื่อ:

```text
⛔ รอบนี้เต็มแล้ว

🏸 8/8 คน

ไม่สามารถลงชื่อเพิ่มได้
```

MVP ไม่มี Waiting List

---

# 13. Leave Game

User กด:

```text
❌ ถอนชื่อ
```

ระบบ:

- Remove / mark player as cancelled
- Update player count
- Update Game Message

ตัวอย่าง:

```text
เชวง ถอนชื่อเรียบร้อยแล้ว

🏸 7/8 คน
```

---

# 14. List Players

User:

```text
บอทจ๋า ใครตีบ้าง
```

Bot:

```text
🏸 พุธ 16 ก.ย.
⏰ 19:00 - 21:00
🏟️ 1 คอร์ท

👥 5/8 คน

1. เชวง
2. Bank
3. Arm
4. Joe
5. Tee
```

---

# 15. Edit Game

Command:

```text
บอทจ๋า แก้ไข
```

Bot แสดง Game ที่ User สามารถแก้ไขได้

จากนั้น:

```text
ต้องการแก้ไขอะไร?

[ 🏟️ จำนวนคอร์ท ]
[ 📅 วันที่ ]
[ ⏰ เวลา ]
[ ⏱️ ระยะเวลา ]
[ ❌ ยกเลิก ]
```

สามารถแก้ไข:

- จำนวนคอร์ท
- วันที่
- เวลา
- duration

เมื่อแก้จำนวนคอร์ท:

```text
1 court = 8
2 courts = 16
3 courts = 24
4 courts = 32
```

ต้อง validate ว่า:

```text
current_players <= new_max_players
```

ถ้าไม่ผ่าน เช่น:

```text
มีผู้เล่นอยู่แล้ว 15 คน

แก้จาก 2 คอร์ท → 1 คอร์ท

1 คอร์ทรับได้เพียง 8 คน
```

ต้อง reject:

```text
❌ ไม่สามารถลดเหลือ 1 คอร์ทได้

ขณะนี้มีผู้เล่น 15 คน
แต่ 1 คอร์ทรองรับได้ 8 คน
```

---

# 16. Cancel Game

Command:

```text
บอทจ๋า ยกเลิก
```

Bot ขอ Confirmation:

```text
⚠️ ยืนยันการยกเลิกรอบตี?

📅 พุธ 16 ก.ย.
⏰ 19:00 - 21:00
🏟️ 1 คอร์ท
👥 5/8 คน

[ ❌ ยืนยันยกเลิก ]
[ กลับ ]
```

เมื่อยกเลิก:

```text
status = cancelled
```

และไม่อนุญาตให้ลงชื่อเพิ่ม

---

# 17. Command Strategy

## Rule-Based Commands

ไม่ต้องใช้ LLM:

```text
บอทจ๋า เปิดตี
บอทจ๋า ลงชื่อ
บอทจ๋า ถอนชื่อ
บอทจ๋า แก้ไข
บอทจ๋า ใครตีบ้าง
บอทจ๋า ยกเลิก
```

ใช้ deterministic parser

---

# 18. LLM Commands

ใช้ Gemini เมื่อ User ใช้ภาษาธรรมชาติ

ตัวอย่าง:

```text
บอทจ๋า พรุ่งนี้สองทุ่มเปิดตีให้หน่อย
```

```text
บอทจ๋า คืนนี้ผมไปตีด้วยนะ
```

```text
บอทจ๋า ผมไปไม่ได้แล้ว ถอนชื่อให้หน่อย
```

```text
บอทจ๋า รอบพรุ่งนี้คนเต็มหรือยัง
```

LLM ต้อง return structured JSON เท่านั้น

ตัวอย่าง:

```json
{
  "intent": "create_game",
  "date": "2026-09-16",
  "time": "20:00"
}
```

Allowed intents:

```text
create_game
join_game
leave_game
list_players
edit_game
cancel_game
check_game
unknown
```

ห้ามให้ LLM สร้าง SQL

ห้ามให้ LLM เรียก Database

ห้ามให้ LLM เรียก LINE API โดยตรง

---

# 19. Database Schema

## users

```text
id
line_user_id
display_name
created_at
updated_at
```

Constraints:

```text
line_user_id UNIQUE
```

---

## games

```text
id
created_by
play_date
start_time
duration_minutes
court_count
max_players
status
created_at
updated_at
```

Status:

```text
open
cancelled
completed
```

Formula:

```text
max_players = court_count * 8
```

---

## game_players

```text
id
game_id
user_id
status
joined_at
updated_at
```

Status:

```text
joined
cancelled
```

Constraints:

```text
UNIQUE(game_id, user_id)
```

---

## Database Access Rules (Raw SQL)

MVP ไม่ใช้ ORM ใด ๆ (ไม่ใช้ Drizzle / Prisma / TypeORM / Knex)

ใช้ driver:

```text
postgres (postgres.js)
```

### Connection

```ts
// src/lib/db.ts
import postgres from "postgres";
import { env } from "./env";

export const sql = postgres(env.DATABASE_URL, {
  prepare: false, // จำเป็นเมื่อใช้ Supabase Transaction Pooler (port 6543)
  max: 1,         // Serverless: 1 connection ต่อ instance
});
```

บน Vercel ให้ใช้ Supabase **Transaction Pooler** connection string

### Rules

1. ทุก query ต้องใช้ tagged template ของ postgres.js (parameterized) เท่านั้น
2. ห้ามต่อ string เพื่อสร้าง SQL เอง
3. ห้ามใช้ `sql.unsafe()` กับค่าที่มาจาก User หรือ LLM
4. SQL ทั้งหมดต้องอยู่ใน Repository layer (`src/repositories/`) เท่านั้น
5. Service layer เรียก Repository ห้ามเขียน SQL ใน Service / Webhook
6. ต้องกำหนด TypeScript type ของผลลัพธ์ทุก query เอง
7. Operation ที่มีหลายขั้นตอนต้องใช้ transaction (`sql.begin`)

ตัวอย่างที่ถูกต้อง:

```ts
const rows = await sql<Game[]>`
  SELECT id, play_date, start_time, duration_minutes,
         court_count, max_players, status, created_by
  FROM games
  WHERE id = ${gameId}
`;
```

ตัวอย่างที่ห้ามทำ:

```ts
// ❌ SQL Injection
await sql.unsafe(`SELECT * FROM games WHERE id = '${gameId}'`);
```

### Join Game ต้องกัน Race Condition

หลายคนกดลงชื่อพร้อมกันได้ ต้อง lock แถว game ก่อนนับจำนวน:

```ts
await sql.begin(async (tx) => {
  const [game] = await tx<Game[]>`
    SELECT id, max_players, status
    FROM games
    WHERE id = ${gameId}
    FOR UPDATE
  `;

  if (!game || game.status !== "open") throw new GameNotOpenError();

  const [{ count }] = await tx<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM game_players
    WHERE game_id = ${gameId} AND status = 'joined'
  `;

  if (count >= game.max_players) throw new GameFullError();

  await tx`
    INSERT INTO game_players (game_id, user_id, status)
    VALUES (${gameId}, ${userId}, 'joined')
    ON CONFLICT (game_id, user_id)
    DO UPDATE SET status = 'joined', updated_at = now()
  `;
});
```

หมายเหตุ: ต้องตรวจก่อนว่า User ยังไม่ได้ `joined` อยู่แล้ว (ตอบ `ℹ️ คุณลงชื่อรอบนี้ไปแล้ว`)

Edit court count ก็ต้องใช้ `FOR UPDATE` แบบเดียวกัน เพื่อตรวจ `current_players <= new_max_players`

### Migration

ใช้ไฟล์ SQL ธรรมดา เรียงตามลำดับ:

```text
db/migrations/
├── 001_create_users.sql
├── 002_create_games.sql
└── 003_create_game_players.sql
```

รันด้วย script ง่าย ๆ (`scripts/migrate.ts`) ที่:

- สร้างตาราง `schema_migrations` เก็บชื่อไฟล์ที่รันแล้ว
- รันเฉพาะไฟล์ที่ยังไม่เคยรัน ภายใน transaction

หรือรันผ่าน Supabase SQL Editor ได้ในช่วงทดลอง

### Initial Schema (SQL)

```sql
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  line_user_id  TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE games (
  id                BIGSERIAL PRIMARY KEY,
  created_by        BIGINT NOT NULL REFERENCES users(id),
  play_date         DATE NOT NULL,
  start_time        TIME NOT NULL,
  duration_minutes  INT NOT NULL CHECK (duration_minutes > 0),
  court_count       INT NOT NULL CHECK (court_count BETWEEN 1 AND 4),
  max_players       INT NOT NULL CHECK (max_players = court_count * 8),
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'cancelled', 'completed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE game_players (
  id          BIGSERIAL PRIMARY KEY,
  game_id     BIGINT NOT NULL REFERENCES games(id),
  user_id     BIGINT NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'joined'
              CHECK (status IN ('joined', 'cancelled')),
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, user_id)
);

CREATE INDEX idx_games_status_date ON games (status, play_date);
CREATE INDEX idx_game_players_game_status ON game_players (game_id, status);
```

---

# 20. Authorization

MVP:

คนที่สร้าง Game (`created_by`) เท่านั้นที่สามารถ:

- Edit Game
- Cancel Game

สมาชิกทั่วไปสามารถ:

- Join
- Leave
- List Players
- Check Game

---

# 21. LINE Webhook

Endpoint:

```text
POST /api/line/webhook
```

Responsibilities:

1. Verify LINE signature
2. Parse event
3. Ignore non-message events unless needed
4. Check message type
5. Check Wake Word
6. Process command
7. Reply through LINE Messaging API

---

# 22. LINE UI

ใช้ LINE UI เป็นหลัก

Prefer:

- Quick Reply
- Buttons
- Flex Message
- Confirmation buttons

ไม่ต้องสร้าง Web UI สำหรับ MVP

---

# 23. Environment Variables

ตัวอย่าง:

```env
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=

GEMINI_API_KEY=

DATABASE_URL=
```

ห้าม commit secrets เข้า Git

ต้องมี:

```text
.env.example
```

---

# 24. Project Structure

Recommended:

```text
badminton-line-bot/
│
├── app/
│   └── api/
│       └── line/
│           └── webhook/
│               └── route.ts
│
├── src/
│   ├── lib/
│   │   ├── line.ts
│   │   ├── gemini.ts
│   │   ├── db.ts
│   │   └── env.ts
│   │
│   ├── commands/
│   │   ├── parser.ts
│   │   └── types.ts
│   │
│   ├── services/
│   │   ├── game.service.ts
│   │   ├── player.service.ts
│   │   └── user.service.ts
│   │
│   ├── repositories/
│   │   ├── game.repository.ts
│   │   ├── player.repository.ts
│   │   ├── user.repository.ts
│   │   └── types.ts
│   │
│   └── line/
│       ├── messages.ts
│       └── flex.ts
│
├── db/
│   └── migrations/
│       ├── 001_create_users.sql
│       ├── 002_create_games.sql
│       └── 003_create_game_players.sql
│
├── scripts/
│   └── migrate.ts
│
├── tests/
│
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

AI CLI สามารถปรับ structure ได้ตามความเหมาะสม แต่ต้องรักษา separation:

```text
Webhook
↓
Command
↓
Service
↓
Repository (Raw SQL)
↓
Database
```

---

# 25. Error Handling

Bot ต้องตอบกรณีผิดพลาดอย่างชัดเจน

ตัวอย่าง:

ไม่มี Game:

```text
❌ ตอนนี้ไม่มีรอบตีที่เปิดอยู่
```

User ลงชื่อซ้ำ:

```text
ℹ️ คุณลงชื่อรอบนี้ไปแล้ว
```

User ถอนชื่อทั้งที่ไม่ได้ลง:

```text
ℹ️ คุณยังไม่ได้ลงชื่อรอบนี้
```

Game เต็ม:

```text
⛔ รอบนี้เต็มแล้ว
```

ไม่มีสิทธิ์แก้:

```text
⛔ คุณไม่มีสิทธิ์แก้ไขรอบตีนี้
```

AI ไม่เข้าใจ:

```text
🤔 ผมยังไม่เข้าใจคำสั่งนี้

ลองพูดว่า:
"บอทจ๋า เปิดตี"
"บอทจ๋า ลงชื่อ"
"บอทจ๋า ใครตีบ้าง"
```

---

# 26. Free-First Requirement

เป้าหมาย MVP:

```text
Hosting       → Free
Database      → Free
LLM           → Free Tier
LINE          → Free Tier / available quota
Domain        → ไม่จำเป็น
```

ห้ามเพิ่ม infrastructure ที่มีค่าใช้จ่ายโดยไม่จำเป็น

ไม่ต้องใช้:

- Redis
- Kafka
- Queue
- Docker
- Kubernetes
- Vector DB
- Separate backend server
- Separate frontend

---

# 27. MVP Scope

## Must Have

- [ ] LINE Webhook
- [ ] Wake Word `บอทจ๋า`
- [ ] Create Game
- [ ] Court count
- [ ] Date
- [ ] Time
- [ ] Duration
- [ ] Automatic max players
- [ ] Join
- [ ] Leave
- [ ] List Players
- [ ] Edit Game
- [ ] Cancel Game
- [ ] Authorization
- [ ] PostgreSQL
- [ ] Gemini integration
- [ ] Rule-based command parser
- [ ] LINE Flex / Buttons

## Not in MVP

- [ ] Payment
- [ ] Cost splitting
- [ ] Badminton skill rating
- [ ] Match making
- [ ] Ranking
- [ ] Multiple badminton groups
- [ ] Public badminton discovery
- [ ] Waiting list
- [ ] Admin dashboard
- [ ] Web application
- [ ] AI Agent
- [ ] Vector database
- [ ] Analytics

---

# 28. Development Priority

Implement in this order:

```text
1. Next.js project
2. LINE Webhook
3. LINE signature verification
4. Wake Word
5. PostgreSQL + postgres.js + SQL migrations
6. User creation
7. Create Game
8. Join Game
9. Leave Game
10. List Players
11. Edit Game
12. Cancel Game
13. LINE Flex Messages
14. Rule-based commands
15. Gemini integration
16. Natural language commands
17. Tests
18. Vercel deployment
```

---

# 29. Definition of Done

MVP ถือว่าเสร็จเมื่อสามารถเอา Bot เข้า LINE Group แล้วทำ flow นี้ได้จริง:

```text
User:

บอทจ๋า เปิดตี

↓

Bot:

กี่คอร์ท?

[1] [2] [3] [4]

↓

เลือก 1

↓

Bot:

วันไหน?

↓

เลือกพรุ่งนี้

↓

Bot:

กี่โมง?

↓

เลือก 19:00

↓

Bot:

เล่นกี่ชั่วโมง?

↓

เลือก 2 ชั่วโมง

↓

Bot:

ยืนยัน?

↓

เปิดตี

↓

🏸 BADMINTON
📅 พรุ่งนี้
⏰ 19:00 - 21:00
🏟️ 1 คอร์ท
👥 0/8 คน

[🙋 ลงชื่อ]
[👀 รายชื่อ]

↓

สมาชิกกด "ลงชื่อ"

↓

👥 1/8 คน

↓

สมาชิกคนอื่นลงชื่อจนครบ

↓

👥 8/8 คน

↓

คนที่ 9 กดลงชื่อ

↓

⛔ รอบนี้เต็มแล้ว
```

ต้องสามารถแก้ไขและยกเลิกได้ และทุกข้อความที่ไม่ได้ขึ้นต้นด้วย `บอทจ๋า` ต้องถูก ignore

---

# 30. AI CLI Instruction

ก่อนเขียน code ให้ AI CLI:

1. อ่าน specification นี้ทั้งหมด
2. สรุป architecture ที่จะใช้
3. ตรวจ dependency ที่จำเป็น
4. ห้ามเพิ่ม feature นอก MVP
5. ห้ามเพิ่ม infrastructure โดยไม่จำเป็น
6. ใช้ TypeScript strict mode
7. Validate ทุก input จาก LINE และ LLM
8. LLM output ต้องผ่าน schema validation
9. ห้ามให้ LLM access database โดยตรง
10. ห้าม commit secrets
11. สร้าง `.env.example`
12. สร้าง README สำหรับ local development
13. สร้าง database migration เป็นไฟล์ `.sql`
14. เขียน tests สำหรับ business rules สำคัญ
15. ห้ามใช้ ORM — ใช้ Raw SQL ผ่าน postgres.js แบบ parameterized เท่านั้น
16. SQL ต้องอยู่ใน Repository layer เท่านั้น

### Critical Business Rules

```text
Wake Word:
message must start with "บอทจ๋า"

Players:
max_players = court_count * 8

Full-time:
every player joins the entire Game duration

Full:
current_players >= max_players → reject join

Edit:
only game creator can edit

Cancel:
only game creator can cancel

LLM:
LLM translates natural language into structured intent
LLM must never directly modify database

Database:
no ORM, raw parameterized SQL only
join / edit court count must run in a transaction with SELECT ... FOR UPDATE
```