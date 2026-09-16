# 🏸 Badminton LINE Bot — MVP Specification

> เอกสารที่เกี่ยวข้อง:
> - `docs/llm-design.md` — System Prompt, Rules, Tool Declarations, Tool Loop
> - `CLAUDE.md` — กฎการทำงานของโปรเจค

---

# 1. Project Overview

สร้าง LINE Bot สำหรับจัดการกลุ่มเล่นแบดมินตันใน LINE Group

เป้าหมายของ MVP:

- เปิดรอบตีแบด
- กำหนดจำนวนคอร์ท
- กำหนดวันและเวลา
- ระบบเสนอจำนวนผู้เล่นสูงสุดตามจำนวนคอร์ท และปรับเองได้
- ระบุชื่อคอร์ทและลิงก์แผนที่
- สมาชิกลงชื่อ
- สมาชิกถอนชื่อ
- ดูรายชื่อผู้เล่น
- แก้ไขรอบตี
- ยกเลิกรอบตี
- ปิดรอบตี (เล่นจบแล้ว)
- ใช้ LLM (Gemini Function Calling) เข้าใจภาษาธรรมชาติ ถาม-ตอบ User และสร้างข้อความตอบกลับ
- เน้น Free Tier / ค่าใช้จ่าย $0 ในช่วงทดลอง

---

# 2. Core Concept

Bot ใช้งานใน LINE Group

Bot จะตอบสนองเฉพาะ:

1. ข้อความที่ขึ้นต้นด้วย `บอทจ๋า`
2. Postback จากปุ่มที่ Bot ส่งเอง (ไม่ต้องมี wake word)

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

- TypeScript (strict mode)
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

- Google Gemini API (SDK: `@google/genai`)
- ใช้ Free Tier
- ใช้ Function Calling (Tools)
- มี System Prompt + Rules กำกับเสมอ
- ชื่อ model กำหนดผ่าน env `GEMINI_MODEL`
- รายละเอียดทั้งหมดอยู่ใน `docs/llm-design.md`

## Validation

- zod (validate input จาก LINE และ arguments จาก LLM)

## Source Control

- GitHub

## Package Manager

- npm หรือ pnpm

---

# 4. Architecture

```text
LINE User (ใน LINE Group)
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
Verify Signature → อ่าน source.groupId
    │
    ▼
Router
    │
    ├── ข้อความไม่มี "บอทจ๋า" ──────────► Ignore
    │
    ├── Postback จากปุ่ม ──────────────┐
    │                                  │
    ├── คำสั่งตรงตัว (Rule-based) ─────┤
    │                                  │
    └── ภาษาธรรมชาติ                    │
            │                          │
            ▼                          │
      Load conversation_sessions       │
            │                          │
            ▼                          │
      LLM (Gemini)                     │
      System Prompt + Rules            │
      + Tool Declarations              │
            │ functionCall             │
            ▼                          │
      Tool Executor (App)              │
      - Validate args (zod)            │
      - Inject user / group จาก event  │
      - Authorization                  │
            │                          │
            └───────────┬──────────────┘
                        ▼
                  Game Service
                        │
                        ▼
              Repository (Raw SQL)
                        │
                        ▼
                   PostgreSQL
      (users, games, game_players,
       pending_actions, conversation_sessions)
                        │
                        ▼
      Tool Result → LLM สรุปเป็นข้อความไทย
      (หรือ Rule-based สร้างข้อความเอง)
                        │
                        ▼
      App ส่ง Reply → LINE Messaging API
```

---

# 5. Important Design Principle

## LLM เป็นล่ามและผู้สนทนา ไม่ใช่ตัวควบคุมระบบ

LLM มีหน้าที่:

1. **แปลภาษา:** เข้าใจภาษาธรรมชาติของ User
2. **ถาม-ตอบ:** ถามข้อมูลที่ขาด ตอบคำถามเกี่ยวกับรอบตี
3. **เลือก Tool:** ขอเรียก Tool ที่ Application ประกาศไว้ พร้อม arguments
4. **สร้างข้อความตอบกลับ:** สรุปผลจาก Tool เป็นภาษาไทยที่อ่านง่าย

จากนั้น **Application** เป็นคนส่งข้อความไป LINE Messaging API

LLM ไม่มีสิทธิ์ทำเองโดยตรง:

- ห้ามเรียก Database
- ห้ามสร้าง SQL
- ห้ามเรียก LINE API
- ห้ามระบุตัวตน User หรือ Group เอง (Application ใส่จาก LINE event)
- ห้ามข้าม Business Rules / Authorization
- ห้ามสร้าง / แก้ไข / ยกเลิก / ปิดรอบโดยไม่มีการกดยืนยันจาก User

LLM ทำได้แค่ **ขอ** เรียก Tool ส่วน Application เป็นคน validate และ execute

ตัวอย่าง:

User:

```text
บอทจ๋า พรุ่งนี้สองทุ่มเปิดตีให้หน่อย
```

LLM → functionCall:

```json
{
  "name": "propose_create_game",
  "args": {
    "play_date": "2026-09-16",
    "start_time": "20:00"
  }
}
```

Application → Tool Result:

```json
{
  "ok": false,
  "error": "MISSING_FIELDS",
  "missing": ["court_count", "duration_minutes"]
}
```

LLM → ข้อความตอบ:

```text
ได้เลย 🏸 รอบพรุ่งนี้ 20:00 นะ
จะจองกี่คอร์ท และเล่นกี่ชั่วโมงดี?
```

Application ส่งข้อความนี้ไป LINE

รายละเอียด Tool ทั้งหมดดูที่ `docs/llm-design.md`

---

# 6. Wake Word Rule

ข้อความ (message event) ต้องขึ้นต้นด้วย:

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

ข้อยกเว้น:

- **Postback event** จากปุ่มที่ Bot ส่ง ไม่ต้องมี wake word
- Postback ต้องผ่านการ validate `data` ด้วย zod ทุกครั้ง
- **ข้อความที่บอทกำลังรอคำตอบอยู่** (ชื่อคอร์ท / ลิงก์แผนที่) ไม่ต้องมี wake word
  - รับเฉพาะข้อความของคนที่สั่งงานไว้ ในกลุ่มเดียวกัน และภายในอายุของ pending action
  - ถ้าไม่มีรายการที่รออยู่ ต้อง ignore เหมือนเดิม
  - ถ้าตรวจสอบไม่ได้ (เช่น ฐานข้อมูลมีปัญหา) ต้องเงียบ ห้ามตอบ error ใส่บทสนทนาในกลุ่ม

---

# 7. Game Rules

## Timezone

วันและเวลาทั้งหมดใช้ `Asia/Bangkok`

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

ค่าตั้งต้น:

```text
max_players = court_count * 8
```

User ปรับจำนวนคนเองได้ตอนเปิดรอบและตอนแก้ไข โดยเลือกจากค่าตั้งต้น ±2 และ ±4

ขอบเขต:

```text
2 <= max_players <= 64
max_players >= จำนวนคนที่ลงชื่อไว้แล้ว (ตอนแก้ไข)
```

## One Open Game per Group

```text
1 LINE Group มีรอบ status = open ได้สูงสุด 1 รอบ
```

- ถ้ามีรอบ `open` อยู่แล้ว → สร้างรอบใหม่ไม่ได้
- บังคับที่ Database ด้วย partial unique index (ดู §20)
- ทุกคำสั่ง (ลงชื่อ, ถอนชื่อ, รายชื่อ, แก้ไข, ยกเลิก, ปิดรอบ) ทำกับ **รอบ open ของกลุ่มนั้น** เสมอ ไม่ต้องเลือกรอบ

⚠️ ความเสี่ยงที่ยอมรับใน MVP:

ถ้าผู้สร้างลืมปิดรอบ กลุ่มจะเปิดรอบใหม่ไม่ได้ ผู้สร้างต้องสั่ง `บอทจ๋า ปิดรอบ` หรือ `บอทจ๋า ยกเลิก` ก่อน (MVP ยังไม่มี admin override)

## Venue

ทุกรอบต้องมี **ชื่อคอร์ท** (1–60 ตัวอักษร) ส่วน **ลิงก์แผนที่** ใส่หรือไม่ใส่ก็ได้

ลิงก์แผนที่รับได้ 2 ทาง:

- วางลิงก์ (http/https) เช่น Google Maps
- แชร์ตำแหน่งผ่าน LINE ระบบจะแปลงพิกัดเป็นลิงก์ Google Maps ให้

## Date / Time Validation

- `play_date` + `start_time` ต้องไม่อยู่ในอดีต
- `duration_minutes` ต้องมากกว่า 0 และเป็นจำนวนเต็มชั่วโมง (60, 120, 180, ...)

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

สร้างรอบได้ 2 ทาง จบที่การ์ดยืนยันเหมือนกัน

ก่อนเริ่มทั้ง 2 ทาง ต้องเช็กว่ากลุ่มยังไม่มีรอบ `open` ถ้ามีอยู่แล้ว:

```text
⛔ กลุ่มนี้มีรอบที่เปิดอยู่แล้ว

📅 พุธ 16 ก.ย.
⏰ 19:00 - 21:00

ต้องปิดรอบหรือยกเลิกรอบเดิมก่อน
```

## 9.1 ทางปุ่ม (Rule-based Wizard)

User:

```text
บอทจ๋า เปิดตี
```

App สร้าง `pending_actions` (type `create_game`) เป็น draft แล้วถามทีละขั้น ทุกปุ่มส่ง postback ที่มี `pending_id`

ลำดับคำถาม:

```text
กี่คอร์ท? → รับกี่คน? → วันไหน? → กี่โมง? → เล่นกี่ชั่วโมง? → คอร์ทไหน? → แผนที่? → พร้อมเพย์? → ยืนยัน
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
👥 รับกี่คน?

ค่าปกติของ 1 คอร์ทคือ 8 คน
```

Quick Reply:

```text
[ 4 คน ] [ 6 คน ] [ 8 คน (ปกติ) ] [ 10 คน ] [ 12 คน ]
```

จากนั้น:

```text
📅 วันไหน?
```

Buttons:

```text
[ วันนี้ ]
[ พรุ่งนี้ ]
[ เลือกวัน ]   ← LINE datetimepicker (mode: date)
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
[ กำหนดเวลาเอง ]   ← LINE datetimepicker (mode: time)
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

จากนั้นถามสถานที่ (ตอบด้วยการพิมพ์ ไม่ต้องมี wake word):

```text
🏟️ ไปตีที่คอร์ทไหน?
```

```text
📍 มีลิงก์แผนที่ไหม?
```

Quick Reply:

```text
[ ข้าม ]
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

กฎของ wizard:

- เฉพาะคนที่เริ่ม wizard เท่านั้นที่กดปุ่มในแต่ละขั้นได้
- draft หมดอายุใน 10 นาที

## 9.2 ทางภาษาธรรมชาติ (LLM)

User:

```text
บอทจ๋า พรุ่งนี้สองทุ่มเปิดตี 2 คอร์ท
```

1. LLM เรียก `propose_create_game` พร้อมข้อมูลที่ได้
2. ถ้าข้อมูลไม่ครบ → Tool คืน `MISSING_FIELDS` → LLM ถามต่อ
3. ถ้าครบ → App สร้าง `pending_actions` แล้วส่งการ์ด Confirmation เดียวกับ §9.1

## 9.3 เมื่อกดยืนยัน

1. Mark `pending_actions` ว่าใช้แล้ว (atomic, ใช้ได้ครั้งเดียว)
2. ตรวจว่าคนกดคือคนที่ขอ
3. INSERT game (ถ้าชน unique index → `⛔ กลุ่มนี้มีรอบที่เปิดอยู่แล้ว`)
4. ส่ง Game Card (§10)

---

# 10. Game Card

ส่งเมื่อ:

- สร้าง Game สำเร็จ
- User ขอดูรายชื่อ (§14)
- แก้ไข Game สำเร็จ

```text
🏸 BADMINTON

📅 พุธ 16 ก.ย.
⏰ 19:00 - 21:00
🏟️ 1 คอร์ท
👥 0/8 คน

ยังไม่มีคนลงชื่อ

[ 🙋 ลงชื่อ ]
[ ❌ ถอนชื่อ ]
[ 👀 รายชื่อ ]
```

## ข้อจำกัดของ LINE

LINE **แก้ไขข้อความที่ส่งไปแล้วไม่ได้**

ดังนั้น MVP ไม่ update การ์ดเดิม:

- Join / Leave → ตอบข้อความสั้น + ปุ่ม
- การ์ดเต็มส่งใหม่เมื่อกด `👀 รายชื่อ` เท่านั้น

---

# 11. Join Game

User กด:

```text
🙋 ลงชื่อ
```

หรือพิมพ์:

```text
บอทจ๋า ลงชื่อ
บอทจ๋า คืนนี้ผมไปตีด้วยนะ
```

ระบบต้อง:

1. Identify LINE User จาก event
2. Upsert user (ดึง display name จาก LINE group member profile API)
3. หารอบ `open` ของกลุ่ม
4. ตรวจว่า User ยังไม่ได้ลงชื่อ
5. ตรวจจำนวนผู้เล่น (ใน transaction + `FOR UPDATE`)
6. เพิ่ม player
7. ตอบข้อความสั้น

ตัวอย่าง:

```text
✅ เชวง ลงชื่อแล้ว

👥 5/8 คน

[ 🙋 ลงชื่อ ]
[ ❌ ถอนชื่อ ]
[ 👀 รายชื่อ ]
```

ลงชื่อไม่ต้องกดยืนยัน

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

หรือพิมพ์:

```text
บอทจ๋า ถอนชื่อ
บอทจ๋า ผมไปไม่ได้แล้ว ถอนชื่อให้หน่อย
```

ระบบ:

- Mark player เป็น `cancelled`
- ตอบข้อความสั้น

ตัวอย่าง:

```text
👋 เชวง ถอนชื่อเรียบร้อยแล้ว

👥 7/8 คน

[ 🙋 ลงชื่อ ]
[ 👀 รายชื่อ ]
```

ถอนชื่อไม่ต้องกดยืนยัน

User ที่ถอนชื่อแล้วลงชื่อกลับได้ ถ้ารอบยังไม่เต็ม

---

# 14. List Players

User:

```text
บอทจ๋า ใครตีบ้าง
```

หรือกด `👀 รายชื่อ`

Bot ส่ง Game Card เต็ม:

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

[ 🙋 ลงชื่อ ]
[ ❌ ถอนชื่อ ]
[ 👀 รายชื่อ ]
```

รายชื่อเรียงตาม `joined_at`

---

# 15. Edit Game

Command:

```text
บอทจ๋า แก้ไข
```

หรือภาษาธรรมชาติ:

```text
บอทจ๋า ขอเปลี่ยนเป็น 2 คอร์ทนะ
```

เฉพาะผู้สร้าง Game

Bot (Quick Reply):

```text
✏️ ต้องการแก้ไขอะไร?

[ 🏟️ จำนวนคอร์ท ] [ 👥 จำนวนคน ] [ 📅 วันที่ ] [ ⏰ เวลา ]
[ ⏱️ ระยะเวลา ] [ 🏸 ชื่อคอร์ท ] [ 📍 แผนที่ ] [ 💸 พร้อมเพย์ ]
```

สามารถแก้ไข:

- จำนวนคอร์ท
  - ถ้าจำนวนคนยังเป็นค่าตั้งต้น (คอร์ทเดิม × 8) จะขยับตามคอร์ทใหม่ และการ์ดยืนยันต้องแสดงให้เห็น
  - ถ้าเจ้าของเคยตั้งจำนวนคนเองไว้ ต้องเก็บค่านั้นไว้ ห้ามทับเงียบ ๆ
- จำนวนคนที่รับ
- วันที่
- เวลา
- duration
- ชื่อคอร์ท
- ลิงก์แผนที่
- เลขพร้อมเพย์

ทุกการแก้ไขต้องผ่านการ์ดยืนยัน (`pending_actions` type `edit_game`)

```text
✏️ ยืนยันการแก้ไข?

🏟️ 1 คอร์ท → 2 คอร์ท
👥 รับ 8 → 16 คน

[ ✅ ยืนยัน ]
[ ❌ ยกเลิก ]
```

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

ต้อง validate ทั้งตอน propose และตอนกดยืนยัน (จำนวนคนอาจเปลี่ยนระหว่างนั้น)

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

แก้เสร็จแล้วส่ง Game Card ใหม่

---

# 16. Cancel Game

Command:

```text
บอทจ๋า ยกเลิก
```

เฉพาะผู้สร้าง Game

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

- ไม่อนุญาตให้ลงชื่อเพิ่ม
- กลุ่มเปิดรอบใหม่ได้

---

# 17. Close Game

ใช้เมื่อเล่นจบแล้ว เพื่อให้กลุ่มเปิดรอบใหม่ได้

Command:

```text
บอทจ๋า ปิดรอบ
```

เฉพาะผู้สร้าง Game

Bot ขอ Confirmation:

```text
🏁 ปิดรอบตีนี้?

📅 พุธ 16 ก.ย.
⏰ 19:00 - 21:00
👥 8/8 คน

[ ✅ ปิดรอบ ]
[ กลับ ]
```

เมื่อปิด:

```text
status = completed
```

Bot:

```text
🏁 ปิดรอบเรียบร้อย ขอบคุณทุกคนที่มาตีนะ 🏸
```

---

# 18. Command Strategy (Hybrid Router)

ลำดับการตัดสินใจ:

```text
1. Postback event        → Postback Handler (ไม่เรียก LLM)
2. ข้อความไม่มี wake word → Ignore
3. คำสั่งตรงตัว          → Rule-based Handler (ไม่เรียก LLM)
4. อื่น ๆ                 → LLM (Gemini + Tools)
```

## Rule-Based Commands

เทียบหลังตัด `บอทจ๋า` และ trim ช่องว่างแล้ว ต้องตรงทั้งข้อความ:

| ข้อความ | Action |
|---|---|
| (ว่าง) / `เมนู` / `ช่วยด้วย` | Help Menu + Quick Reply |
| `เปิดตี` | Create Wizard (§9.1) |
| `ลงชื่อ` | Join (§11) |
| `ถอนชื่อ` | Leave (§13) |
| `ใครตีบ้าง` / `รายชื่อ` | List Players (§14) |
| `แก้ไข` | Edit Menu (§15) |
| `ยกเลิก` | Cancel Confirmation (§16) |
| `ปิดรอบ` | Close Confirmation (§17) |

ใช้ deterministic parser

## Postback Data

Postback `data` เป็น query string และต้อง validate ด้วย zod:

```text
action=join
action=leave
action=list
action=wizard&pending_id=<uuid>&step=court&value=2
action=confirm&pending_id=<uuid>
action=reject&pending_id=<uuid>
```

- `action=join|leave|list` ทำกับรอบ `open` ของกลุ่มที่กด
- ปุ่มที่มี `pending_id` ต้องตรวจว่าคนกดคือ `requested_by`, ยังไม่หมดอายุ และยังไม่ถูกใช้

---

# 19. LLM (Natural Language)

ใช้ Gemini Function Calling เมื่อข้อความไม่ตรงกับ Rule-based

ตัวอย่าง:

```text
บอทจ๋า พรุ่งนี้สองทุ่มเปิดตีให้หน่อย
บอทจ๋า คืนนี้ผมไปตีด้วยนะ
บอทจ๋า ผมไปไม่ได้แล้ว ถอนชื่อให้หน่อย
บอทจ๋า รอบพรุ่งนี้คนเต็มหรือยัง
```

สรุปข้อกำหนด (รายละเอียดใน `docs/llm-design.md`):

- มี System Prompt + Rules ทุก request
- Tools ที่ประกาศ:

```text
get_open_game
list_players
join_game
leave_game
propose_create_game
propose_edit_game
propose_cancel_game
propose_close_game
```

- Tool ที่ขึ้นต้น `propose_` ไม่เปลี่ยน game ทันที แต่สร้าง `pending_actions` แล้ว App ส่งปุ่มยืนยัน
- Arguments จาก LLM ต้องผ่าน zod ทุกครั้ง
- ไม่มี Tool ไหนรับ `user_id` / `group_id` จาก LLM
- วน Tool call ได้สูงสุด 3 รอบต่อ 1 ข้อความ
- เก็บบริบทบทสนทนาใน `conversation_sessions` (TTL 10 นาที)
- ตอบเฉพาะเรื่องรอบตีและวิธีใช้บอท ภาษาไทยเป็นกันเอง สั้น
- ถ้า Gemini ใช้ไม่ได้ → Fallback (§26)

ห้ามให้ LLM สร้าง SQL

ห้ามให้ LLM เรียก Database

ห้ามให้ LLM เรียก LINE API โดยตรง

---

# 20. Database

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
line_group_id
created_by
play_date
start_time
duration_minutes
court_count
max_players
court_name
location_url
promptpay
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

Constraints:

```text
UNIQUE(line_group_id) WHERE status = 'open'
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

## pending_actions

ใช้กับ Create Wizard และทุกการ์ดยืนยัน

```text
id (uuid)
line_group_id
requested_by
game_id (nullable)
action_type
payload (jsonb)
expires_at
used_at (nullable)
created_at
updated_at
```

Action type:

```text
create_game
edit_game
cancel_game
close_game
```

กฎ:

- อายุ 10 นาที
- ใช้ได้ครั้งเดียว (`used_at`)
- คนกดต้องเป็น `requested_by`

---

## conversation_sessions

เก็บบริบทการคุยกับ LLM

```text
id
line_group_id
line_user_id
messages (jsonb)
expires_at
created_at
updated_at
```

Constraints:

```text
UNIQUE(line_group_id, line_user_id)
```

กฎ:

- เก็บข้อความล่าสุดไม่เกิน 10 ข้อความ
- อายุ 10 นาทีนับจากข้อความล่าสุด
- ล้างเมื่อ action ถูกยืนยันสำเร็จ หรือเมื่อ User คนนั้นใช้ Rule-based command

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
5. Service layer เรียก Repository ห้ามเขียน SQL ใน Service / Webhook / LLM
6. ต้องกำหนด TypeScript type ของผลลัพธ์ทุก query เอง
7. Operation ที่มีหลายขั้นตอนต้องใช้ transaction (`sql.begin`)
8. ทุก query ของ game ต้องกรองด้วย `line_group_id`

ตัวอย่างที่ถูกต้อง:

```ts
const rows = await sql<Game[]>`
  SELECT id, play_date, start_time, duration_minutes,
         court_count, max_players, status, created_by
  FROM games
  WHERE line_group_id = ${groupId} AND status = 'open'
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
    WHERE line_group_id = ${groupId} AND status = 'open'
    FOR UPDATE
  `;

  if (!game) throw new NoOpenGameError();

  const [existing] = await tx<{ status: string }[]>`
    SELECT status
    FROM game_players
    WHERE game_id = ${game.id} AND user_id = ${userId}
  `;

  if (existing?.status === "joined") throw new AlreadyJoinedError();

  const [{ count }] = await tx<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM game_players
    WHERE game_id = ${game.id} AND status = 'joined'
  `;

  if (count >= game.max_players) throw new GameFullError();

  await tx`
    INSERT INTO game_players (game_id, user_id, status)
    VALUES (${game.id}, ${userId}, 'joined')
    ON CONFLICT (game_id, user_id)
    DO UPDATE SET status = 'joined', joined_at = now(), updated_at = now()
  `;
});
```

Edit court count ก็ต้องใช้ `FOR UPDATE` แบบเดียวกัน เพื่อตรวจ `current_players <= new_max_players`

### ใช้ Pending Action ได้ครั้งเดียว

```ts
const [action] = await tx<PendingAction[]>`
  UPDATE pending_actions
  SET used_at = now(), updated_at = now()
  WHERE id = ${pendingId}
    AND line_group_id = ${groupId}
    AND used_at IS NULL
    AND expires_at > now()
  RETURNING *
`;

if (!action) throw new PendingExpiredError();
if (action.requested_by !== userId) throw new NotRequesterError();
```

โค้ดนี้ต้องอยู่ใน `sql.begin` เพื่อให้ `throw` rollback `used_at` กลับ ไม่อย่างนั้นคนอื่นกดปุ่มแล้ว action จะใช้ไม่ได้อีก

### Create Game ชน Unique Index

ถ้า INSERT games แล้วได้ error code `23505` (unique_violation) → ตอบ `GAME_ALREADY_OPEN`

### Migration

ใช้ไฟล์ SQL ธรรมดา เรียงตามลำดับ:

```text
db/migrations/
├── 001_create_users.sql
├── 002_create_games.sql
├── 003_create_game_players.sql
├── 004_create_pending_actions.sql
├── 005_create_conversation_sessions.sql
└── 006_game_capacity_and_venue.sql
```

รันด้วย script ง่าย ๆ (`scripts/migrate.ts`) ที่:

- สร้างตาราง `schema_migrations` เก็บชื่อไฟล์ที่รันแล้ว
- รันเฉพาะไฟล์ที่ยังไม่เคยรัน ภายใน transaction

หรือรันผ่าน Supabase SQL Editor ได้ในช่วงทดลอง

⚠️ การรัน migration ต้องได้รับคำสั่งจากเจ้าของโปรเจคก่อน (ดู `CLAUDE.md`)

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
  line_group_id     TEXT NOT NULL,
  created_by        BIGINT NOT NULL REFERENCES users(id),
  play_date         DATE NOT NULL,
  start_time        TIME NOT NULL,
  duration_minutes  INT NOT NULL CHECK (duration_minutes > 0 AND duration_minutes % 60 = 0),
  court_count       INT NOT NULL CHECK (court_count BETWEEN 1 AND 4),
  max_players       INT NOT NULL CHECK (max_players BETWEEN 2 AND 64),
  court_name        TEXT,
  location_url      TEXT,
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'cancelled', 'completed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_games_one_open_per_group
  ON games (line_group_id)
  WHERE status = 'open';

CREATE INDEX idx_games_group_status ON games (line_group_id, status);

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

CREATE INDEX idx_game_players_game_status ON game_players (game_id, status);

CREATE TABLE pending_actions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_group_id  TEXT NOT NULL,
  requested_by   BIGINT NOT NULL REFERENCES users(id),
  game_id        BIGINT REFERENCES games(id),
  action_type    TEXT NOT NULL
                 CHECK (action_type IN ('create_game', 'edit_game', 'cancel_game', 'close_game')),
  payload        JSONB NOT NULL DEFAULT '{}',
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pending_actions_group ON pending_actions (line_group_id, expires_at);

CREATE TABLE conversation_sessions (
  id             BIGSERIAL PRIMARY KEY,
  line_group_id  TEXT NOT NULL,
  line_user_id   TEXT NOT NULL,
  messages       JSONB NOT NULL DEFAULT '[]',
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (line_group_id, line_user_id)
);
```

---

# 21. Authorization

คนที่สร้าง Game (`created_by`) เท่านั้นที่สามารถ:

- Edit Game
- Cancel Game
- Close Game

สมาชิกทั่วไปสามารถ:

- Create Game (ถ้ากลุ่มยังไม่มีรอบ open)
- Join
- Leave
- List Players
- ถามข้อมูลรอบตี

ปุ่มยืนยัน / ปุ่ม wizard:

- คนกดต้องเป็นคนที่ขอ (`pending_actions.requested_by`)
- ต้องกดในกลุ่มเดียวกับที่ขอ
- ต้องทำกับ **รอบเดียวกับที่ออกการ์ดไว้** (`pending_actions.game_id`)
  ถ้ารอบนั้นถูกปิดหรือยกเลิกไปแล้ว การ์ดใบเก่าต้องใช้ไม่ได้ ห้ามไปทำกับรอบใหม่ที่เพิ่งเปิด

ตัวตนของ User และ Group มาจาก LINE event เท่านั้น ห้ามเชื่อค่าจาก LLM หรือจากข้อความ

---

# 22. LINE Webhook

Endpoint:

```text
POST /api/line/webhook
```

Responsibilities:

1. Verify LINE signature (`x-line-signature`) ด้วย raw body
2. Parse และ validate event
3. รับเฉพาะ event:
   - `message` (type `text`)
   - `postback`
   - `join` (Bot ถูกเชิญเข้ากลุ่ม → ส่งข้อความแนะนำตัว)
4. ถ้า `source.type` ไม่ใช่ `group`:
   - ข้อความที่มี wake word → ตอบ `ℹ️ บอทนี้ใช้งานได้ใน LINE Group เท่านั้น`
   - อื่น ๆ → ignore
5. Check Wake Word (เฉพาะ message)
6. ส่งเข้า Router (§18)
7. Reply ผ่าน LINE Reply API (ใช้ `replyToken`)
8. คืน HTTP 200 เสมอเมื่อ signature ถูกต้อง (error ภายในให้ log และตอบ User แทน)

หมายเหตุ:

- `replyToken` ใช้ได้ครั้งเดียวและมีอายุสั้น ต้องตอบให้เสร็จเร็ว (Gemini timeout ดู `docs/llm-design.md`)
- Reply API ส่งได้สูงสุด 5 message ต่อครั้ง ถ้าเกินต้องตัดก่อนส่ง ไม่ปล่อยให้ LINE ปฏิเสธทั้งชุด
- รับได้สูงสุด 10 event ต่อ 1 request และทำทีละ 5 event พร้อมกัน
  เพื่อไม่ให้ handler ใช้เวลานานจน LINE ถือว่า timeout แล้วส่งซ้ำด้วย replyToken ที่ใช้ไปแล้ว
- MVP ใช้ Reply API เท่านั้น ไม่ใช้ Push API (ประหยัดโควตา)

## ข้อจำกัด: 1 กลุ่ม = 1 Official Account

LINE ยอมให้มี **LINE Official Account ได้แค่ตัวเดียวต่อ 1 group / multi-person chat**

> "At any time, only one LINE Official Account can be in a group chat or multi-person chat."
> — [LINE Developers — Group chats and multi-person chats](https://developers.line.biz/en/docs/messaging-api/group-chats/)

ถ้ากลุ่มนั้นมี OA ตัวอื่นอยู่ก่อนแล้ว (เช่น ขุนทอง ที่กลุ่มแบดนิยมใช้หารค่าสนาม) Bot จะเข้ากลุ่มไม่ได้
และ webhook จะ **ไม่ได้รับ event `join` เลย** ใครเข้าก่อนได้ก่อน ไม่เกี่ยวกับว่าบัญชีไหน verified

[FAQ ของ LINE](https://developers.line.biz/en/faq/tags/group-chats/) ระบุสาเหตุที่ OA ออกจากกลุ่มเองไว้ 2 ข้อ:

1. setting `เข้าร่วมในแชท` ของ OA เป็น "ไม่อนุญาตให้เข้าร่วมกลุ่มหรือแชทแบบหลายคน"
2. มี OA ตัวอื่นอยู่ในกลุ่มนั้นแล้ว

อาการที่เห็นในแชท (ยืนยันด้วยการทดสอบจริง 16 ก.ย. 2026):

| ข้อความในกลุ่ม | ความหมาย |
| --- | --- |
| `added <bot>` แล้วตามด้วย `<bot> left the group` ทันที | ถูก LINE เตะออก |
| `invited <bot> ... Wait for them to join` แล้วค้าง | ไม่ได้เข้ากลุ่ม |
| `<bot> joined the group` แล้วตามด้วยข้อความแนะนำตัว | เข้าสำเร็จ |

ข้อ 2 แก้ที่ code ไม่ได้ ต้องเอา OA ตัวเดิมออกจากกลุ่มก่อน หรือแยกกลุ่มจัดก๊วนออกจากกลุ่มหลัก
เอกสารติดตั้งต้องบอกเรื่องนี้ไว้ให้ชัด

---

# 23. LINE UI

ใช้ LINE UI เป็นหลัก

Prefer:

- Quick Reply
- Buttons
- Flex Message
- Datetime picker action
- Confirmation buttons

ไม่ต้องสร้าง Web UI สำหรับ MVP

---

# 24. Environment Variables

ตัวอย่าง:

```env
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=

GEMINI_API_KEY=
GEMINI_MODEL=

DATABASE_URL=
```

ห้าม commit secrets เข้า Git

ต้องมี:

```text
.env.example
```

Env ทั้งหมดต้อง validate ด้วย zod ตอน start (`src/lib/env.ts`)

---

# 25. Project Structure

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
│   │   ├── time.ts
│   │   └── env.ts
│   │
│   ├── router/
│   │   ├── router.ts
│   │   ├── rule-commands.ts
│   │   └── postback.ts
│   │
│   ├── llm/
│   │   ├── system-prompt.ts
│   │   ├── tools.ts
│   │   ├── tool-schemas.ts
│   │   ├── tool-executor.ts
│   │   └── agent.ts
│   │
│   ├── services/
│   │   ├── game.service.ts
│   │   ├── player.service.ts
│   │   ├── user.service.ts
│   │   ├── pending-action.service.ts
│   │   └── session.service.ts
│   │
│   ├── repositories/
│   │   ├── game.repository.ts
│   │   ├── player.repository.ts
│   │   ├── user.repository.ts
│   │   ├── pending-action.repository.ts
│   │   ├── session.repository.ts
│   │   └── types.ts
│   │
│   ├── errors/
│   │   └── app-errors.ts
│   │
│   └── line/
│       ├── messages.ts
│       └── flex.ts
│
├── db/
│   └── migrations/
│       ├── 001_create_users.sql
│       ├── 002_create_games.sql
│       ├── 003_create_game_players.sql
│       ├── 004_create_pending_actions.sql
│       └── 005_create_conversation_sessions.sql
│
├── scripts/
│   └── migrate.ts
│
├── tests/
│
├── docs/
│   ├── specification.md
│   └── llm-design.md
│
├── .env.example
├── package.json
├── tsconfig.json
├── CLAUDE.md
└── README.md
```

AI CLI สามารถปรับ structure ได้ตามความเหมาะสม แต่ต้องรักษา separation:

```text
Webhook
↓
Router (Postback / Rule / LLM)
↓
Service
↓
Repository (Raw SQL)
↓
Database
```

LLM layer เรียกได้แค่ Service ผ่าน Tool Executor เท่านั้น

---

# 26. Error Handling

Bot ต้องตอบกรณีผิดพลาดอย่างชัดเจน

Error code ใช้ร่วมกันระหว่าง Service, Rule-based และ Tool Result (ดู `docs/llm-design.md`)

| Code | ข้อความ (Rule-based) |
|---|---|
| `NO_OPEN_GAME` | `❌ ตอนนี้ไม่มีรอบตีที่เปิดอยู่` |
| `GAME_ALREADY_OPEN` | `⛔ กลุ่มนี้มีรอบที่เปิดอยู่แล้ว` |
| `ALREADY_JOINED` | `ℹ️ คุณลงชื่อรอบนี้ไปแล้ว` |
| `NOT_JOINED` | `ℹ️ คุณยังไม่ได้ลงชื่อรอบนี้` |
| `GAME_FULL` | `⛔ รอบนี้เต็มแล้ว` |
| `NOT_GAME_CREATOR` | `⛔ คุณไม่มีสิทธิ์แก้ไขรอบตีนี้` |
| `COURT_TOO_SMALL` | `❌ ไม่สามารถลดเหลือ N คอร์ทได้ ...` |
| `DATE_IN_PAST` | `❌ วันเวลานี้ผ่านไปแล้ว` |
| `NO_CHANGES` | `ℹ️ ไม่มีอะไรเปลี่ยนแปลง` |
| `PENDING_EXPIRED` | `⛔ ปุ่มนี้หมดอายุหรือถูกใช้ไปแล้ว` |
| `NOT_REQUESTER` | `⛔ เฉพาะคนที่สั่งเท่านั้นที่กดปุ่มนี้ได้` |
| `INTERNAL_ERROR` | `😵 ระบบขัดข้อง ลองใหม่อีกครั้งนะ` |

Code ที่ใช้เฉพาะใน LLM Tool Result (ไม่แสดงให้ User โดยตรง): `MISSING_FIELDS`, `INVALID_ARGUMENT`, `INVALID_TOOL`

## LLM Fallback

เมื่อ Gemini error / timeout / โควตาหมด (429) / ตอบผิดรูปแบบ:

```text
🤔 ตอนนี้ผมยังไม่เข้าใจประโยคนี้

ลองเลือกคำสั่งด้านล่างได้เลย
```

Quick Reply:

```text
[ เปิดตี ] [ ลงชื่อ ] [ ถอนชื่อ ] [ ใครตีบ้าง ]
```

Rule-based และ Postback ต้องทำงานได้ปกติแม้ Gemini ใช้ไม่ได้

---

# 27. Free-First Requirement

เป้าหมาย MVP:

```text
Hosting       → Free
Database      → Free
LLM           → Free Tier
LINE          → Free Tier / available quota (ใช้ Reply API)
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

ข้อยกเว้นเดียว: **Vercel Cron วันละครั้ง** เรียก `GET /api/health` เพื่อไม่ให้โปรเจค Supabase แบบ Free
ถูก pause จากการไม่มีการใช้งาน (Hobby รันได้วันละครั้ง ไม่มีค่าใช้จ่าย) และใช้เป็นตัวเช็กสุขภาพระบบไปด้วย

ของที่หมดอายุ (`pending_actions`, `conversation_sessions`) ลบทิ้งตอนเขียนรายการใหม่ ไม่ต้องมี job แยก

---

# 28. MVP Scope

## Must Have

- [x] LINE Webhook (message, postback, join)
- [x] Wake Word `บอทจ๋า`
- [x] Hybrid Router (Postback / Rule-based / LLM)
- [x] Create Game (Wizard + LLM)
- [x] Court count
- [x] Max players (ค่าตั้งต้นจากคอร์ท ปรับเองได้)
- [x] Date
- [x] Time
- [x] Duration
- [x] Court name + map link
- [x] One open game per group
- [x] Join
- [x] Leave
- [x] List Players
- [x] Edit Game
- [x] Cancel Game
- [x] Close Game
- [x] Pending actions + Confirmation buttons
- [x] Authorization
- [x] PostgreSQL (Raw SQL)
- [x] Gemini Function Calling + System Prompt + Rules
- [x] Conversation sessions
- [x] LLM Fallback
- [x] Buttons / Quick Reply
- [ ] LINE Flex Message (ยังใช้ buttons template อยู่)
- [x] เลขพร้อมเพย์ของรอบตี (ตั้งตอนเปิดรอบ / แก้ทีหลังได้)
- [ ] คิดเงินและหารค่าใช้จ่ายต่อรอบ (ค่าคอร์ท / ลูกแบด / ค่าอื่น ๆ หารเท่า)
- [ ] บันทึกว่าใครจ่ายแล้ว / ยังไม่จ่าย และเตือนตอนปิดรอบ

รายละเอียดของสามข้อล่างอยู่ใน `docs/PRP/bill-splitting.md`

## Not in MVP

- [ ] Payment (บอทไม่รับ-ส่งเงินจริง ไม่ผูกบัญชีธนาคาร เป็นแค่กระดานจดว่าใครจ่ายแล้ว)
- [ ] ตรวจสอบสลิปโอนเงิน (ไม่มีผู้ให้บริการรายไหนฟรี)
- [ ] หารไม่เท่า / เลือกคนร่วมจ่ายเป็นรายรายการ
- [ ] ทวงเงินอัตโนมัติ (ต้องใช้ Push API ขัดข้อ §27)
- [ ] ยอดค้างข้ามรอบ
- [ ] Badminton skill rating
- [ ] Match making
- [ ] Ranking
- [ ] Multiple open games per group
- [ ] Cross-group features / Public badminton discovery
- [ ] Waiting list
- [ ] Admin override / Admin dashboard
- [ ] Auto close game
- [ ] Web application
- [ ] Autonomous AI Agent (LLM ตัดสินใจเปลี่ยนข้อมูลเองโดยไม่ยืนยัน)
- [ ] General chat นอกเรื่องรอบตี
- [ ] Vector database
- [ ] Analytics

---

# 29. Development Priority

Implement in this order:

```text
1. Next.js project
2. LINE Webhook
3. LINE signature verification
4. Wake Word + group source check
5. PostgreSQL + postgres.js + SQL migrations
6. User creation
7. Create Game (Wizard + pending_actions)
8. Join Game
9. Leave Game
10. List Players
11. Edit Game
12. Cancel Game
13. Close Game
14. LINE Flex Messages
15. Rule-based commands + Postback router
16. Gemini client + System Prompt + Rules
17. Tool declarations + Tool executor
18. Conversation sessions
19. LLM Fallback
20. Tests
21. Vercel deployment
22. เลขพร้อมเพย์ของรอบตี ✅
23. คิดเงิน + หารค่าใช้จ่าย + บันทึกการจ่าย
```

ข้อ 22-23 ทำตามลำดับใน `docs/PRP/bill-splitting.md` §16

---

# 30. Definition of Done

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
[❌ ถอนชื่อ]
[👀 รายชื่อ]

↓

สมาชิกกด "ลงชื่อ"

↓

✅ ลงชื่อแล้ว 👥 1/8 คน

↓

สมาชิกคนอื่นลงชื่อจนครบ

↓

👥 8/8 คน

↓

คนที่ 9 กดลงชื่อ

↓

⛔ รอบนี้เต็มแล้ว
```

และต้องทำได้ด้วย:

- `บอทจ๋า พรุ่งนี้สองทุ่มเปิดตี 2 คอร์ท 2 ชั่วโมง` → การ์ดยืนยัน → เปิดรอบได้
- `บอทจ๋า พรุ่งนี้สองทุ่มเปิดตี` → บอทถามจำนวนคอร์ทและชั่วโมง → ตอบต่อได้
- `บอทจ๋า คืนนี้ผมไปด้วย` → ลงชื่อสำเร็จ
- เปิดรอบซ้ำตอนมีรอบ open → ถูก reject
- คนที่ไม่ใช่ผู้สร้างสั่งแก้ไข / ยกเลิก / ปิดรอบ → ถูก reject
- คนอื่นกดปุ่มยืนยันของคนอื่น → ถูก reject
- ผู้สร้างแก้ไข ยกเลิก และปิดรอบได้
- ปิด `GEMINI_API_KEY` แล้ว rule-based ยังทำงาน และข้อความภาษาธรรมชาติได้ Fallback
- ทุกข้อความที่ไม่ได้ขึ้นต้นด้วย `บอทจ๋า` ถูก ignore

---

# 31. AI CLI Instruction

ก่อนเขียน code ให้ AI CLI:

1. อ่าน `CLAUDE.md` และปฏิบัติตามกฎ (ห้ามเริ่ม code / git / แก้ database ก่อนได้รับคำสั่ง)
2. อ่าน specification นี้และ `docs/llm-design.md` ทั้งหมด
3. สรุป architecture ที่จะใช้
4. ตรวจ dependency ที่จำเป็น
5. ห้ามเพิ่ม feature นอก MVP
6. ห้ามเพิ่ม infrastructure โดยไม่จำเป็น
7. ใช้ TypeScript strict mode
8. Validate ทุก input จาก LINE และ LLM ด้วย zod
9. ห้ามให้ LLM access database หรือ LINE API โดยตรง
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
message must start with "บอทจ๋า" (postback from bot buttons is exempt)

Group:
bot works in LINE groups only; every game query is scoped by line_group_id

Players:
max_players defaults to court_count * 8 and the organiser may change it (2..64)
max_players can never drop below the number of people already signed up

One open game:
a group can have at most 1 game with status = open

Full-time:
every player joins the entire Game duration

Full:
current_players >= max_players → reject join

Edit / Cancel / Close:
only game creator can do it, and only after pressing a confirmation button

Confirmation:
pending action is single-use, expires in 10 minutes,
and only the requester can press it

LLM:
LLM translates natural language, asks follow-up questions,
calls declared tools only, and writes the reply text.
App validates tool args, injects user/group from the LINE event,
executes services, and sends the reply to LINE.
LLM must never directly access database or LINE API.

LLM failure:
fall back to quick-reply menu; rule-based commands must keep working

Database:
no ORM, raw parameterized SQL only
join / edit court count must run in a transaction with SELECT ... FOR UPDATE
```
