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

เรียกชื่อครั้งเดียวแล้วสั่งงานต่อได้โดยไม่ต้องเรียกซ้ำ ดู "โหมดฟัง" ใน §6

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
    ├── ข้อความไม่มี "บอทจ๋า"
    │   และไม่ได้อยู่ในโหมดฟัง ─────────► Ignore
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
- **ข้อความของคนที่เพิ่งเรียกบอท ระหว่างอยู่ในโหมดฟัง** (ดูหัวข้อถัดไป)

## โหมดฟัง

เรียก `บอทจ๋า` ครั้งเดียว แล้วสั่งงานในข้อความถัดไปได้เลยโดยไม่ต้องเรียกชื่ออีก

```text
สมชาย:  บอทจ๋า
บอท:    ว่าไงครับพี่ 🏸                    ← เปิดโหมดฟังให้สมชาย
สมชาย:  เปิดตีพรุ่งนี้สองทุ่ม              ← ไม่ต้องมี wake word
บอท:    กี่คอร์ทดีครับ?
สมชาย:  2 คอร์ท
บอท:    ✅ เปิดรอบแล้ว                     ← ยังฟังต่อ
สมชาย:  ใครตีบ้าง                          ← สั่งต่อได้เลย ไม่ต้องเรียกชื่อใหม่
บอท:    [รายชื่อ]
สมชาย:  เดี๋ยวเจอกันนะทุกคน                ← เงียบ (ไม่ได้คุยกับบอท)
สมหญิง: เย้ ไปด้วย                        ← เงียบ (คนละคน)
```

`บอทจ๋า เปิดตี` แบบเดิมยังใช้ได้ทุกประการ โหมดฟังเป็นทางเลือกเพิ่ม ไม่ได้แทนที่

### ขอบเขต

- 1 โหมดฟังต่อ (group, user) เก็บที่ `conversation_sessions.listening_until`
- รับเฉพาะข้อความของ **คนที่เรียกบอท** ในกลุ่มเดียวกัน คนอื่นพูดต้องเงียบ
- รับเฉพาะ message type `text` ตำแหน่งที่แชร์มาลอย ๆ ไม่นับเป็นคำสั่ง
- ถ้ายังไม่ได้ตั้งค่า Gemini ไม่ต้องเปิดโหมดฟัง เพราะตีความประโยคอิสระไม่ได้อยู่ดี

### เปิดเมื่อ

- เรียก `บอทจ๋า` เฉย ๆ ไม่มีคำสั่งตามมา
- ใช้คำสั่งที่ยังคุยไม่จบ (`เปิดตี` `แก้ไข` `ยกเลิก` `ปิดรอบ` `คิดเงิน` `ยกเลิกบิล`)
- LLM ตอบกลับโดยที่งานยังไม่เสร็จ เช่น ถามข้อมูลเพิ่ม หรือรอให้กดปุ่มยืนยัน

อายุหน้าต่างคือ **2 นาที** นับใหม่ทุกครั้งที่บอทตอบ

### ต่ออายุเมื่อ

**ทุกครั้งที่มีปฏิสัมพันธ์กับบอท** — พิมพ์คำสั่ง กดปุ่ม หรือคุยกับ LLM
นับรวมกรณีที่คำสั่งล้มเหลวด้วย เพราะคนที่เพิ่งโดนบอทบอกว่า "ยังไม่มีรอบที่เปิดอยู่"
มักสั่งต่อทันที

⚠️ เดิมปิดเมื่อ "งานสำเร็จ" ซึ่งเป็นกรณีปกติที่สุด ผู้ใช้จึงต้องเรียก `บอทจ๋า`
ใหม่แทบทุกประโยค (พบจากการใช้จริง 17 ก.ย. 2026) โหมดฟังแทบไม่เคยได้ทำงาน

### ปิดเมื่อ

- เงียบครบ 2 นาที
- ผู้ใช้พิมพ์คำสั่งปิด เช่น `พอแล้ว` `จบ` `ขอบคุณ`
- ข้อความเป็นคำรับคำสั้น ๆ (`555` `โอเค` `ครับ` อีโมจิล้วน) — ปิดโดยไม่เรียก LLM

⚠️ **LLM ตอบ `IGNORE` ไม่ปิดโหมดฟัง** แค่เงียบสำหรับข้อความนั้น
`IGNORE` แปลว่า "ข้อความนี้ไม่ได้คุยกับบอท" ไม่ใช่ "จบบทสนทนาแล้ว"
ถ้าปิด ประโยคกำกวมประโยคเดียวจะฆ่าบทสนทนาทิ้ง แล้วคำสั่งตรงตัวที่พิมพ์ตามมาก็ตกไปด้วย
(พบจากการใช้จริง: `เหลือใคร` → IGNORE → `ใครยังไม่จ่าย` ถูกเมิน ทั้งที่เป็นคำสั่งตรงตัว)

กติกาเดียวคือ **ปิดเมื่อผู้ใช้บอกเองว่าจบ หรือเงียบครบ 2 นาที**
ไม่ปิดเพราะทำงานเสร็จ และไม่ปิดเพราะข้อความเดียวที่อ่านไม่ออก

### ข้อบังคับ

- ในโหมดฟัง ถ้าตีความไม่ออกต้อง **เงียบ** ห้ามตอบเมนูสำรอง
  ไม่งั้นบอทจะพ่นเมนูใส่ทุกประโยคในกลุ่ม
- ข้อความที่ LLM บอกว่าไม่เกี่ยวกับบอท ห้ามบันทึกลง session history
- ลำดับต้องเป็น "คำตอบที่บอทรออยู่" มาก่อน "โหมดฟัง" เสมอ

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

ตอนเปิดรอบ wizard ไม่ถามจำนวนคน ใช้ค่าตั้งต้นจากจำนวนคอร์ทเลย (spec §9.1)
ใครอยากปรับสั่ง `บอทจ๋า แก้ไข` แล้วเลือกจากค่าตั้งต้น ±2 และ ±4 ได้ตลอด
ส่วนทางภาษาธรรมชาติบอกจำนวนคนมาพร้อมกันได้ตั้งแต่ตอนเปิดรอบ

ขอบเขต:

```text
2 <= max_players <= 64
max_players >= จำนวนคนที่ลงชื่อไว้แล้ว (ตอนแก้ไข)
```

**แขกนับรวมด้วย** คนที่ถูกพามาแม้ไม่ได้อยู่ในกลุ่ม LINE ก็กินคอร์ทจริง (§11.1)

## เปิดได้หลายรอบพร้อมกัน

```text
1 LINE Group มีรอบ status = open ได้สูงสุด 3 รอบ
```

ที่มาและเหตุผลทั้งหมดอยู่ใน `docs/PRP/multi-open-rounds.md`

- เปิดครบ 3 รอบแล้วเปิดรอบใหม่ไม่ได้ (`GAME_LIMIT_REACHED`) เช็กตั้งแต่เริ่มถามข้อมูลรอบ และเช็กซ้ำตอนกดยืนยัน
- จำนวนสูงสุดบังคับในโค้ด ไม่ใช่ที่ Database ตอนกดยืนยันล็อกกลุ่มด้วย `pg_advisory_xact_lock(hashtext(line_group_id))`
  แล้วค่อยนับ กันสองคนกดยืนยันพร้อมกันตอนมี 2 รอบแล้วได้ 4 รอบ
- รอบที่วันเล่นผ่านไปแล้ว (`play_date` < วันนี้ ตามเวลาไทย) ปิดให้อัตโนมัติทุกเช้า 10:00 (§27.2) ไม่ push แจ้ง
  รอบที่เล่นคืนนี้จึงปิดพรุ่งนี้ 10 โมง ระหว่างนั้นยังลงชื่อ ถอนชื่อได้เหมือนเดิม

### เลือกรอบ

คำสั่งที่ไม่ได้บอกว่ารอบไหน ดูเฉพาะรอบที่คำสั่งนั้นทำได้จริง

```text
ไม่เหลือรอบไหนเลย → บอกเหตุผล
เหลือ 1 รอบ       → ทำเลย ไม่ถาม
หลายรอบ           → การ์ด "รอบไหน?" ปุ่มละรอบ เรียงตามวันเล่น
```

กลุ่มที่มีรอบเดียว ทุกคำสั่งทำงานและตอบเหมือนเดิมทุกคำ ไม่มีคำถามเพิ่ม

| คำสั่ง | รอบที่เลือกได้ | ไม่เหลือรอบไหนเลย |
| --- | --- | --- |
| `ลงชื่อ` | รอบที่ยังไม่ได้ลง และยังไม่เต็ม | ลงครบทุกรอบแล้ว `ALREADY_JOINED` · ที่เหลือเต็มหมด `GAME_FULL` |
| `ลงชื่อ <ชื่อ ...>` | รอบที่ยังไม่เต็ม และยังมีคนในรายชื่อที่ยังไม่ได้ลง ทุกชื่อลงรอบเดียวกัน | เหมือน `ลงชื่อ` |
| `ถอนชื่อ` | รอบที่คนพิมพ์ลงไว้ | `NOT_JOINED` |
| `ถอนชื่อ <ชื่อ ...>` | รอบที่มีคนในรายชื่อที่คนสั่งถอนได้ | `ℹ️ <ชื่อ> ไม่ได้อยู่ในรายชื่อรอบไหนเลย` |
| `ใครตีบ้าง` / `รายชื่อ` | ทุกรอบ ไม่ถาม | – |
| `แก้ไข` / `ยกเลิก` / `ปิดรอบ` | รอบที่คนพิมพ์เป็นคนเปิด | `NOT_GAME_CREATOR` |
| `คิดเงิน` → คิดค่ารอบ | เกมที่คนพิมพ์เปิด มีคนลงชื่อ และยังเปิดอยู่หรือปิดไปไม่เกิน 7 วัน | ปุ่มคิดค่ารอบไม่ขึ้น พร้อมเหตุผล |

ไม่มีรอบเปิดอยู่เลย → `NO_OPEN_GAME` เหมือนเดิม

การ์ด "รอบไหน?":

```text
📅 ถอนจากรอบไหน?
[พุธ 24 ก.ย. 19:00 · คอร์ทสามย่าน]
[เสาร์ 27 ก.ย. 18:00 · ABC Badminton]
[ยกเลิก]
```

- ผูกกับ `pending_actions` ชนิด `choose_game` เก็บคำสั่ง รายชื่อ และค่าที่ LLM เสนอไว้ใน payload
  กดได้เฉพาะคนสั่ง ครั้งเดียว อายุ 10 นาที (§21)
- กดแล้วทำคำสั่งเดิมกับรอบนั้น และเช็กทุกอย่างใหม่ ระหว่างรอกดรอบอาจเต็ม ถูกปิด หรือคนถูกถอนไปแล้ว
- ป้ายปุ่มไม่เกิน 40 ตัวอักษร ชื่อคอร์ทยาวตัดท้ายด้วย `…` ปุ่มละแถว
- พิมพ์ตอบเป็นวันแทนการกดได้ในโหมดฟัง เช่น "เสาร์" เพราะคำถามถูกจำไว้ในบทสนทนา
- ไม่รับวันต่อท้ายคำสั่งพิมพ์ เช่น `ลงชื่อ พุธ` เพราะชนกับการลงชื่อแทนแขกที่ชื่อ "พุธ"
- ถอนคนอื่นที่สั่งเป็นประโยค (§13) การกดเลือกรอบนับเป็นการยืนยันไปในตัว

กลุ่มที่เปิดอยู่หลายรอบ ผลลัพธ์ต้องบอกว่ารอบไหน (ใส่เวลาด้วย เพราะวันเดียวกันเปิดได้หลายรอบ):

```text
✅ เชวง ลงชื่อแล้ว (พุธ 24 ก.ย. 19:00)
👥 5/8 คน
```

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

ก่อนเริ่มทั้ง 2 ทาง ต้องเช็กว่ากลุ่มยังเปิดไม่ครบ 3 รอบ (§7) ถ้าครบแล้ว:

```text
⛔ กลุ่มนี้เปิดรอบไว้ครบ 3 รอบแล้ว

• พุธ 16 ก.ย. 19:00 · ABC Badminton
• เสาร์ 19 ก.ย. 18:00 · คอร์ทสามย่าน
• อาทิตย์ 20 ก.ย. 17:00 · คอร์ทบางนา

ต้องปิดหรือยกเลิกรอบเดิมก่อน ถึงจะเปิดรอบใหม่ได้
```

กดยืนยันแล้วเช็กซ้ำอีกครั้ง เพราะระหว่างที่การ์ดค้างอยู่อาจมีคนเปิดรอบจนครบไปแล้ว

## 9.1 ทางปุ่ม (Rule-based Wizard)

User:

```text
บอทจ๋า เปิดตี
```

App สร้าง `pending_actions` (type `create_game`) เป็น draft แล้วถามทีละขั้น ทุกปุ่มส่ง postback ที่มี `pending_id`

ลำดับคำถาม:

```text
กี่คอร์ท? → ตีเมื่อไหร่? → เล่นกี่ชั่วโมง? → ที่เดิมไหม? → ยืนยัน
```

ก๊วนที่ยังไม่เคยเปิดรอบ ขั้น "ที่เดิมไหม?" จะกลายเป็นถามทีละข้อ:

```text
... → คอร์ทไหน? → แผนที่? → พร้อมเพย์? → ยืนยัน
```

สามอย่างที่ตัดออกจากลำดับเดิม:

| ตัดอะไร | ทำไม |
|---|---|
| `รับกี่คน?` | คิดจากจำนวนคอร์ทให้เลย (คอร์ท × 8) ใครอยากเปลี่ยนสั่ง `บอทจ๋า แก้ไข` ได้ตลอด |
| `วันไหน?` + `กี่โมง?` | รวมเป็นคำถามเดียว คนนึกออกพร้อมกันอยู่แล้วว่าจะตีเมื่อไหร่ |
| `คอร์ทไหน?` + `แผนที่?` + `พร้อมเพย์?` | ก๊วนประจำตีที่เดิมทุกสัปดาห์ ยุบเป็นปุ่ม `ที่เดิม` ปุ่มเดียว |

Bot:

```text
🏸 เปิดรอบตีแบด กี่คอร์ท?
```

ปุ่มท้ายการ์ด (แถวละ 2 ปุ่ม):

```text
[ 1 คอร์ท ] [ 2 คอร์ท ]
[ 3 คอร์ท ] [ 4 คอร์ท ]
```

จากนั้นถามวันและเวลาพร้อมกัน ปุ่มลัดใช้เวลาของรอบที่แล้วเป็นตัวตั้ง
ถ้ายังไม่เคยเปิดรอบเลยใช้ 19:00

```text
📅 ตีเมื่อไหร่?
```

```text
[ วันนี้ 19:00 ] [ พรุ่งนี้ 19:00 ]
[ เลือกวันและเวลา ]   ← LINE datetimepicker (mode: datetime)
```

จากนั้น:

```text
⏱️ เล่นกี่ชั่วโมง?
```

```text
[ 1 ชั่วโมง ]
[ 2 ชั่วโมง ]
[ 3 ชั่วโมง ]
```

จากนั้นถามสถานที่ ถ้ากลุ่มเคยเปิดรอบมาก่อน เสนอของเดิมให้กดทีเดียวจบ:

```text
🏟️ ที่เดิมไหม?

ABC Badminton
📍 มีลิงก์แผนที่
💸 พร้อมเพย์ 081-234-5678

[ ที่เดิม ]
[ เปลี่ยนที่ ]
```

กด `ที่เดิม` = ยกชื่อคอร์ท ลิงก์แผนที่ และเลขพร้อมเพย์ของรอบก่อนมาทั้งชุด
กด `เปลี่ยนที่` หรือกลุ่มที่ยังไม่เคยเปิดรอบ จะถูกถามทีละข้อแทน (ตอบด้วยการพิมพ์ ไม่ต้องมี wake word):

```text
🏟️ ไปตีที่คอร์ทไหน?
```

```text
📍 มีลิงก์แผนที่ไหม?      [ ข้าม ]
```

```text
💸 เลขพร้อมเพย์?          [ ใช้ 081-234-5678 ] [ ข้าม ]
```


สุดท้าย Bot แสดง Confirmation:

```text
🏸 เปิดตีแบด

📅 พุธ 16 ก.ย.
⏰ 19:00 - 21:00
🏸 1 คอร์ท
👥 รับ 8 คน

ยืนยันไหม?

[ เปิดตี ] [ ยกเลิก ]
```

กฎของ wizard:

- เฉพาะคนที่เริ่ม wizard เท่านั้นที่กดปุ่มในแต่ละขั้นได้ คนอื่นกดแล้วไม่มีผลและบอทไม่ตอบ (§23)
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
- แก้ไข Game สำเร็จ

เป็น **ข้อความล้วน ไม่มีปุ่ม** (ดู §23 กติกาการแนบปุ่ม)

```text
🏸 เปิดรอบตีแล้ว

🏟️ ABC Badminton
📅 พุธ 16 ก.ย.
⏰ 19:00 - 21:00
🏸 1 คอร์ท · 👥 0/8 คน
📍 https://maps.google.com/...
```

เพราะไม่ได้ใช้ buttons template จึงไม่ติดเพดาน 160 ตัวอักษร ใส่ชื่อคอร์ทและลิงก์แผนที่ได้ครบ

## ข้อจำกัดของ LINE

LINE **แก้ไขข้อความที่ส่งไปแล้วไม่ได้**

ดังนั้น MVP ไม่ update การ์ดเดิม:

- Join / Leave → ตอบข้อความสั้นใบใหม่
- ขอดูรายชื่อ → ส่งรายชื่อ (§14) ไม่ส่งการ์ดรอบตีซ้ำ

ผลข้างเคียงที่ยอมรับ: ปุ่มที่บอทเคยส่งไปแล้วยังค้างอยู่ในแชทและกดได้เสมอ บอทเอาปุ่มออกไม่ได้
จึงทำให้การกดที่ไม่ควรมีผลเงียบไปแทน: กดปุ่มของคนอื่นหรือปุ่มที่ใช้ไปแล้ว บอทไม่ตอบอะไร (§23)
Postback `join` / `leave` / `list` / `bill_*` ต้องรองรับต่อไป แม้บอทจะไม่ส่งปุ่มพวกนี้ออกไปใหม่แล้ว

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
3. เลือกรอบ (§7) กลุ่มที่เปิดหลายรอบอาจต้องถาม "รอบไหน?"
4. ตรวจว่า User ยังไม่ได้ลงชื่อ
5. ตรวจจำนวนผู้เล่น (ใน transaction + `FOR UPDATE`)
6. เพิ่ม player
7. ตอบข้อความสั้น

ตัวอย่าง:

```text
✅ เชวง ลงชื่อแล้ว
👥 5/8 คน
```

ลงชื่อไม่ต้องกดยืนยัน และไม่ต้องแนบปุ่มต่อท้าย (§23)

## 11.1 ลงชื่อแทนคนอื่น และพาแขกมา

```text
บอทจ๋า ลงชื่อ กิ้ฟ วิท
```

```text
✅ ฮก ลงชื่อให้ กิ้ฟ, วิท
🆕 เพิ่มแขกใหม่: กิ้ฟ, วิท
👥 7 คน
```

**แขก** คือคนที่ไม่ได้อยู่ในกลุ่ม LINE เก็บเป็นแถวใน `users` ที่ `line_user_id` เป็น NULL
และผูกกับกลุ่มที่พามา ชื่อเดิมในกลุ่มเดิมได้แถวเดิมเสมอ ประวัติการเล่นและการจ่ายเงินจึงตามตัวไป

**ชื่อที่พิมพ์มาแปลเป็นคนได้จากสองที่เท่านั้น**

```text
1. แขกของกลุ่มนี้
2. สมาชิกที่เคยลงชื่อในรอบของกลุ่มนี้มาก่อน
```

บอทดึงรายชื่อสมาชิกจาก LINE ไม่ได้ (`GET /v2/bot/group/{groupId}/members/ids`
ใช้ได้เฉพาะบัญชี verified หรือ premium) คนที่ไม่เคยคุยกับบอทเลยจึงต้องพิมพ์ครั้งแรกเอง

ชื่อที่ไม่รู้จักตอน **ลงชื่อ** ถือว่าเป็นแขกใหม่ สร้างให้เลย
แต่ตอน **ถอนชื่อ** ห้ามสร้าง ตอบว่า `ℹ️ <ชื่อ> ไม่ได้อยู่ในรายชื่อรอบนี้`
(ไม่รู้จักชื่อ กับรู้จักแต่ไม่ได้ลงชื่อ ตอบเหมือนกัน เพราะคนสั่งถามแค่ว่าอยู่ในรายชื่อหรือเปล่า)
กลุ่มที่เปิดหลายรอบแล้วไม่อยู่รอบไหนเลย ตอบว่า `ℹ️ <ชื่อ> ไม่ได้อยู่ในรายชื่อรอบไหนเลย`

ชื่อซ้ำกันหลายคน → `PERSON_AMBIGUOUS` ถามกลับ ไม่เดา

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

ถอนชื่อแล้วกลับมาลงใหม่ได้เสมอ แต่ถ้าเปลี่ยนใจเกิน 2 ครั้งในรอบเดียว
(`game_players.change_count >= 3`) บอทจะแซวต่อท้ายว่า "ตกลงจะเล่นหรือไม่เล่น"
เป็นมุขในก๊วน ไม่ได้บล็อกอะไร และนับแยกกันของใครของมัน

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
👋 เชวง ถอนชื่อแล้ว
👥 7/8 คน
```

ถอนชื่อไม่ต้องกดยืนยัน และไม่ต้องแนบปุ่มต่อท้าย (§23)
**ยกเว้น** สั่งเป็นประโยค (ผ่าน LLM) ให้ถอนชื่อ **คนอื่น** ต้องกดยืนยันก่อน (`pending_actions` type `leave_players`)
เพราะประโยคในแชทอาจเป็นมุก เช่น "ยังไม่ให้ louis ตีแบด 555" ส่วนคำสั่งพิมพ์ `บอทจ๋า ถอนชื่อ กิ้ฟ` ยังถอนทันที

ก่อนถอนต้องเช็กตามลำดับ: มีรอบเปิดอยู่ → ชื่ออยู่ในรายชื่อรอบนี้ → คนสั่งมีสิทธิ์ถอน
การ์ดยืนยันขึ้นเฉพาะคนที่ถอนได้จริง คนที่ไม่อยู่ในรายชื่อหรือถอนไม่ได้บอกไว้ใต้รายชื่อเลย

กลุ่มที่เปิดหลายรอบ (§7): ลงไว้รอบเดียวถอนเลย ลงหลายรอบถามว่าถอนจากรอบไหน
ถอนคนอื่นผ่านประโยคตอนเขาอยู่หลายรอบ ถามรอบก่อน กดเลือกรอบแล้วถอนเลย ไม่ต้องยืนยันซ้ำ
คำสั่งเดียวทำกับรอบเดียว `ถอนชื่อ กิ้ฟ วิท` ตอนสองคนอยู่คนละรอบ ต้องสั่งอีกครั้งสำหรับอีกรอบ

ถอนชื่อแทนกันได้ แต่ **เฉพาะเจ้าตัวกับคนที่ลงชื่อให้** (เก็บที่ `game_players.added_by`)

```text
ฮกพากิ้ฟมา   → ฮกถอนกิ้ฟได้ คนอื่นถอนไม่ได้
ฮกลงให้แบงค์  → แบงค์ถอนเองก็ได้ ฮกถอนให้ก็ได้ คนอื่นถอนไม่ได้
```

คนเปิดรอบไม่ได้สิทธิ์พิเศษตรงนี้ เพราะไม่ได้เป็นคนพาเขามา
ผิดเงื่อนไข → `NOT_YOUR_GUEST` และต้องบอกเหตุผล ไม่ใช่เงียบ

User ที่ถอนชื่อแล้วลงชื่อกลับได้ ถ้ารอบยังไม่เต็ม

---

# 14. List Players

User:

```text
บอทจ๋า ใครตีบ้าง
```

Bot ส่งรายชื่อ **รอบละข้อความ ไม่มีปุ่ม และไม่ส่งการ์ดรอบตีตามมาอีกใบ**
กลุ่มที่เปิดหลายรอบได้รายชื่อทุกรอบในคำตอบเดียว ไม่ถาม (ไม่เกิน 3 ใบ)

```text
🏟️ ABC Badminton
📅 พุธ 16 ก.ย.
⏰ 19:00 - 21:00
🏸 1 คอร์ท
📍 https://maps.google.com/...

👥 5/8 คน

1. เชวง
2. Bank
3. Arm
4. Joe
5. Tee
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

เฉพาะผู้สร้าง Game เปิดไว้หลายรอบถามก่อนว่าแก้รอบไหน (§7)
wizard แก้ไขทำกับรอบที่การ์ดออกไว้ให้ (`pending_actions.game_id`) ไม่ใช่ "รอบที่เปิดอยู่"

Bot (การ์ดพร้อมปุ่มท้ายการ์ด):

```text
✏️ ต้องการแก้ไขอะไร?

[ จำนวนคอร์ท ] [ จำนวนคน ]
[ วันที่ ]     [ เวลา ]
[ ระยะเวลา ]   [ ชื่อคอร์ท ]
[ แผนที่ ]     [ พร้อมเพย์ ]
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

แก้ไปแก้มาเกิน 2 ครั้ง (`games.edit_count >= 3`) บอทจะบ่นต่อท้ายว่าเปลือง token
เป็นมุขในก๊วน ไม่ได้บล็อกอะไร ยังแก้ได้ตามปกติ

ทุกการแก้ไขต้องผ่านการ์ดยืนยัน (`pending_actions` type `edit_game`)

```text
✏️ ยืนยันการแก้ไข?

🏸 1 คอร์ท → 2 คอร์ท
👥 รับ 8 → 16 คน

[ ยืนยัน ]
[ ยกเลิก ]
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

เฉพาะผู้สร้าง Game เปิดไว้หลายรอบถามก่อนว่ายกเลิกรอบไหน (§7)

Bot ขอ Confirmation:

```text
⚠️ ยืนยันการยกเลิกรอบตี?

📅 พุธ 16 ก.ย.
⏰ 19:00 - 21:00
🏸 1 คอร์ท
👥 5/8 คน

[ ยืนยันยกเลิก ]
[ กลับ ]
```

เมื่อยกเลิก:

```text
status = cancelled
```

- ไม่อนุญาตให้ลงชื่อเพิ่ม
- นับว่าไม่ได้เล่น คิดค่ารอบของรอบนี้ไม่ได้

---

# 17. Close Game

ใช้เมื่อเล่นจบแล้ว ไม่ปิดเองก็ได้ ระบบปิดรอบที่เลยวันเล่นให้ทุกเช้า (§7)

Command:

```text
บอทจ๋า ปิดรอบ
```

เฉพาะผู้สร้าง Game เปิดไว้หลายรอบถามก่อนว่าปิดรอบไหน (§7)

ปิดรอบไม่ขวางการคิดเงิน คิดค่ารอบของเกมที่ปิดไปไม่เกิน 7 วันได้ (PRP multi-open-rounds §5.1)
การ์ดที่ค้างในแชทของรอบที่ถูกปิดหรือยกเลิกไปแล้ว (แก้ไข ยกเลิก ปิด เลือกรอบ ถอนชื่อ) กดแล้วไม่มีผล

Bot ขอ Confirmation:

```text
🏁 ปิดรอบตีนี้?

📅 พุธ 16 ก.ย.
⏰ 19:00 - 21:00
👥 8/8 คน

[ ปิดรอบ ]
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
1. Postback event                    → Postback Handler (ไม่เรียก LLM)
2. ข้อความมี wake word
   2.1 คำสั่งปิดโหมดฟัง               → ปิดโหมดฟัง (ไม่เรียก LLM)
   2.2 คำสั่งตรงตัว                   → Rule-based Handler (ไม่เรียก LLM)
   2.3 เรียกชื่อเฉย ๆ                 → ทักกลับ + เปิดโหมดฟัง (ไม่เรียก LLM)
   2.4 อื่น ๆ                         → LLM (Gemini + Tools)
3. ข้อความไม่มี wake word
   3.1 บอทรอคำตอบจากคนนี้อยู่          → Text Answer Handler (ไม่เรียก LLM)
   3.2 คนนี้อยู่ในโหมดฟัง (§6)
       3.2.1 คำสั่งปิดโหมดฟัง / คำรับคำสั้น ๆ → ปิดโหมดฟัง (ไม่เรียก LLM)
       3.2.2 คำสั่งตรงตัว                    → Rule-based Handler (ไม่เรียก LLM)
       3.2.3 อื่น ๆ                          → LLM แบบเงียบได้ ถ้าตีความไม่ออก
   3.3 นอกนั้น                        → Ignore
```

## Rule-Based Commands

เทียบหลังตัด `บอทจ๋า` และ trim ช่องว่างแล้ว ต้องตรงทั้งข้อความ:

| ข้อความ | Action |
|---|---|
| (ว่าง) | ทักกลับ + เปิดโหมดฟัง (§6) |
| `เมนู` / `ช่วยด้วย` | การ์ด Help Menu พร้อมปุ่มลัด |
| `พอแล้ว` / `จบ` / `ขอบคุณ` | ปิดโหมดฟัง (§6) |
| `เปิดตี` | Create Wizard (§9.1) |
| `ลงชื่อ` | Join (§11) |
| `ถอนชื่อ` | Leave (§13) |
| `ใครตีบ้าง` / `รายชื่อ` | List Players (§14) |
| `แก้ไข` | Edit Menu (§15) |
| `ยกเลิก` | Cancel Confirmation (§16) |
| `ปิดรอบ` | Close Confirmation (§17) |
| `คิดเงิน` | การ์ด "คิดเงินอะไรดี?" คิดค่ารอบ / สร้างบิลใหม่ / แก้บิลเดิม (§23 คิดเงิน) |
| `บิล` | แสดงการ์ดบิลของกลุ่ม |
| `ใครยังไม่จ่าย` | รายชื่อคนที่ยังไม่จ่าย |
| `จ่ายแล้ว` / `ยังไม่จ่าย` | เปลี่ยนสถานะการจ่ายของตัวเอง |
| `ยกเลิกบิล` | Cancel Bill Confirmation |

ใช้ deterministic parser

บางคำสั่งรับ **ส่วนเติมท้าย** ได้ (PRP `guests-split-bills-and-digest` §8.1)
ไม่มีส่วนเติม = พฤติกรรมเดิมทุกประการ

| รูปแบบ | ตัวอย่าง |
|---|---|
| `ลงชื่อ <ชื่อ ...>` | `บอทจ๋า ลงชื่อ กิ้ฟ วิท` — ลงให้คนอื่นหรือพาแขกมา |
| `ถอนชื่อ <ชื่อ ...>` | ถอนได้เฉพาะเจ้าตัวกับคนที่ลงชื่อให้ |
| `จ่ายแล้ว` / `ยังไม่จ่าย` `<ชื่อ ...>` | จ่ายแทนแขกที่พามา |
| `จ่ายแล้ว` / `ยังไม่จ่าย` `<ชื่อ ...> <ชื่อบิล>` | เจาะจงบิลด้วย เช่น `บอทจ๋า จ่ายแล้ว วิท ร้านโชคดี` (เทียบท้ายข้อความกับชื่อบิลที่เปิดอยู่) |
| `คิดเงิน <ชื่อบิล>` | บิลลอย ๆ ชื่อนั้น ไม่ผูกกับรอบตี แล้วพิมพ์รายการมาอิสระ |
| `บิล` / `ใครยังไม่จ่าย` / `ยกเลิกบิล` `<ชื่อบิล>` | เจาะจงบิลเมื่อมีหลายใบ |

ไม่ระบุชื่อบิล บอทเลือกเฉพาะใบที่คำสั่งนั้นมีอะไรให้ทำ เช่น `จ่ายแล้ว` ดูเฉพาะใบที่คนนั้นยังค้าง
บิลที่ยกเลิกหรือทุกคนจ่ายครบแล้วถือว่าจบ เหลือหลายใบค่อยถามกลับ (PRP `guests-split-bills-and-digest` §5.2)

ชื่อบิลอยู่บรรทัดเดียวเสมอ ข้อความ**หลายบรรทัด**ที่ขึ้นต้นด้วย `คิดเงิน` `บิล` `ใครยังไม่จ่าย` `ยกเลิกบิล`
จึงไม่ใช่คำสั่ง ส่งต่อให้ LLM เพราะคือคนกำลังพิมพ์รายการในบิล เช่น `บิล ร้านโชคดี` ตามด้วยค่าข้าวค่าน้ำ
ถ้าจับเป็นคำสั่ง `บิล` จะได้ขอดูบิลชื่อยาวทั้งก้อนแล้วตอบว่าหาบิลไม่เจอ

## Postback Data

Postback `data` เป็น query string และต้อง validate ด้วย zod:

```text
action=join
action=leave
action=list
action=wizard&pending_id=<uuid>&step=court&value=2
action=confirm&pending_id=<uuid>
action=reject&pending_id=<uuid>
action=wizard&pending_id=<uuid>&step=court_fee|shuttle_count|shuttle_price|extra&value=...
action=wizard&pending_id=<uuid>&step=bill_kind&value=game|new|edit
action=wizard&pending_id=<uuid>&step=edit_bill&value=<id บิล>
action=wizard&pending_id=<uuid>&step=edit&value=add|remove|back
action=wizard&pending_id=<uuid>&step=edit_remove&value=<id รายการ>|new<ลำดับ>
action=bill_paid
action=bill_unpaid
action=bill_status
```

- `action=join|leave|list` ทำกับรอบ `open` ของกลุ่มที่กด
- ปุ่มที่มี `pending_id` ต้องตรวจว่าคนกดคือ `requested_by`, ยังไม่หมดอายุ และยังไม่ถูกใช้
  ไม่ผ่าน (`NOT_REQUESTER` / `PENDING_EXPIRED`) → บอทไม่ตอบอะไร ไม่ส่งข้อความ error ลงกลุ่ม (§23)
- ปุ่ม postback ไม่ตั้ง `displayText` เพราะ LINE จะโพสต์ข้อความนั้นในนามคนกด
  คนที่กดปุ่มของคนอื่นจะทิ้งข้อความลอย ๆ ไว้ในกลุ่มโดยที่บอทไม่ตอบ
- `join` / `leave` / `list` / `bill_paid` / `bill_unpaid` / `bill_status` บอทไม่ส่งปุ่มพวกนี้ออกไปใหม่แล้ว (§23)
  แต่ยังต้องรองรับ เพราะปุ่มเก่าที่ส่งไปแล้วค้างอยู่ในแชทและถูกกดได้เสมอ

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
get_open_games         ทุกรอบที่เปิดอยู่
list_players           รับ round_date / round_time ไม่ระบุได้ทุกรอบ
join_game              รับ names[] เพื่อลงชื่อแทนหรือพาแขกมา และ round_date / round_time
leave_game             รับ names[] และ round_date / round_time
propose_create_game
propose_edit_game      รับ round_date / round_time (play_date / start_time คือค่าใหม่)
propose_cancel_game    รับ round_date / round_time
propose_close_game     รับ round_date / round_time
get_bill               รับ bill_title
propose_create_bill    รับ title (บิลลอย ๆ) และ payers[] (รายการที่เก็บบางคน)
mark_my_payment        รับ names[] เพื่อจ่ายแทน และ bill_title
```

- Tool ที่ขึ้นต้น `propose_` ไม่เปลี่ยน game ทันที แต่สร้าง `pending_actions` แล้ว App ส่งปุ่มยืนยัน
- `join_game` / `leave_game` / `mark_my_payment` ตอบด้วยข้อความของระบบอย่างเดียว ทั้งตอนสำเร็จและไม่สำเร็จ
  ไม่ส่งข้อความที่ LLM แต่ง เพราะเคยเกิดจริง (2026-09-18) ว่า tool ไม่สำเร็จแต่ LLM พิมพ์ว่า "ถอนชื่อ louis ให้แล้ว"
- ทุก error code ต้องมีข้อความของตัวเอง ห้ามตกไปเป็น "ระบบขัดข้อง" (`tests/error-messages.test.ts` วนเช็กทุก code)
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

เก็บทั้งสมาชิก LINE และแขกที่ถูกพามา (§11.1)

```text
id
line_user_id     -- NULL เมื่อเป็นแขก
line_group_id    -- NULL เมื่อเป็นสมาชิก LINE (คนเดียวอยู่ได้หลายกลุ่ม)
display_name
created_at
updated_at
```

Constraints:

```text
line_user_id UNIQUE
CHECK (มีอย่างใดอย่างหนึ่งเท่านั้น: line_user_id หรือ line_group_id)
UNIQUE(line_group_id, display_name) WHERE line_user_id IS NULL
```

ข้อสุดท้ายทำให้แขกชื่อเดิมในกลุ่มเดิมได้แถวเดิมเสมอ ไม่งอกคนใหม่ทุกสัปดาห์

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
edit_count
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
ไม่มี unique index ของรอบที่เปิดอยู่แล้ว (ลบใน migration 017)
เปิดพร้อมกันได้ไม่เกิน 3 รอบ บังคับในโค้ดด้วย advisory lock ของกลุ่ม (§7)
```

`updated_at` ของรอบที่ปิดแล้วคือเวลาที่ปิด เพราะรอบที่ปิดแล้วแก้ไขไม่ได้อีก
ใช้นับ 7 วันที่ยังคิดค่ารอบได้ ปิดเองและปิดอัตโนมัติต้องตั้งค่านี้ทั้งคู่

---

## game_players

```text
id
game_id
user_id
status
change_count
added_by         -- NULL = ลงชื่อเอง มีค่า = คนที่ลงชื่อให้ (§13)
joined_at
updated_at
```

`change_count` = จำนวนครั้งที่เปลี่ยนใจหลังลงชื่อครั้งแรก (ลงครั้งแรก = 0, ถอน = 1, กลับมาลงใหม่ = 2)

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
create_bill
cancel_bill
edit_bill
leave_players
choose_game
```

`create_bill` ใช้กับการ์ด "คิดเงินอะไรดี?" ด้วย (`payload.bill_menu = true`) การ์ดนั้นกดได้ครั้งเดียว

`leave_players` เก็บ `payload.user_ids` ของคนที่จะถอน กดยืนยันแล้วเช็กสิทธิ์ใหม่ทั้งหมดตอนถอนจริง
ถอนจากรอบของการ์ด (`game_id`) เท่านั้น รอบนั้นถูกปิดไปแล้วการ์ดใช้ไม่ได้ (migration 016)

`choose_game` คือการ์ด "รอบไหน?" (§7) เก็บ `payload.intent` (คำสั่งที่จะทำต่อ) `payload.names` และ `payload.patch`
(ค่าที่ LLM เสนอไว้ เช่นค่าที่จะแก้ หรือรายการในบิล) กดเลือกรอบแล้วใช้การ์ดทิ้งก่อนทำต่อ (migration 017)

`edit_bill` เปิดใบใหม่ทุกครั้งที่เพิ่มหรือลบรายการ แล้วใช้ใบเดิมทิ้ง
LINE แก้ข้อความที่ส่งไปแล้วไม่ได้ การ์ดแก้บิลใบเก่าจึงยังค้างในแชท
ถ้าใช้ pending ใบเดียว กดยืนยันบนการ์ดใบเก่าจะยืนยันของล่าสุดซึ่งไม่ตรงกับที่การ์ดใบนั้นแสดง

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
- คอลัมน์ `listening_until` บอกว่าคนนี้อยู่ในโหมดฟังถึงเมื่อไหร่ (§6)

---

## bills / bill_items / bill_item_payers / bill_shares

รายละเอียดทั้งหมดอยู่ใน [`docs/PRP/guests-split-bills-and-digest.md`](PRP/guests-split-bills-and-digest.md) §7
สรุปสิ่งที่ต่างจากบิลรุ่นแรก (`docs/PRP/bill-splitting.md`):

```text
bills            line_group_id (บิลยืนจากกลุ่ม ไม่ใช่จากรอบ)
                 game_id NULL ได้ (บิลลอย ๆ)
                 title    ใช้อ้างถึงเมื่อกลุ่มมีบิลเปิดหลายใบ
                 promptpay ของบิลเอง คัดลอกมาตอนสร้าง

bill_items       รายการย้ายจาก jsonb มาเป็นตาราง
bill_item_payers ใครร่วมจ่ายรายการไหน คนละเท่าไหร่
bill_shares      + paid_by (ใครเป็นคนบอกว่าจ่ายแล้ว)
```

```text
UNIQUE(line_group_id, title) WHERE status = 'sent'
```

เลิกบังคับ 1 รอบ 1 บิลแล้ว รอบหนึ่งมีได้ทั้งค่าคอร์ทและค่ากินข้าวหลังตี

**Invariant (ทดสอบใน test ไม่ใช่ CHECK):**
`SUM(bill_item_payers.amount) = SUM(bill_shares.amount) = bills.total_satang`

---

## group_digests

กันไม่ให้กลุ่มได้รับสรุปประจำสัปดาห์ซ้ำในวันเดียวกัน (§27.2)

```text
line_group_id  PRIMARY KEY
last_sent_on   DATE
updated_at
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

### Create Game เกินจำนวนรอบ

ตอนกดยืนยันเปิดรอบ ล็อกกลุ่มด้วย `SELECT pg_advisory_xact_lock(hashtext(line_group_id))` ในทรานแซกชันเดียวกัน
แล้วค่อยนับรอบที่เปิดอยู่ ครบ 3 รอบแล้ว → `GAME_LIMIT_REACHED` (§7)
ไม่มี unique index ช่วยกันแล้ว ถ้าไม่ล็อก สองคนกดยืนยันพร้อมกันจะนับได้ 2 รอบทั้งคู่แล้วเปิดเป็น 4 รอบ

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

⚠️ นี่คือ schema **ตอนเริ่มโปรเจค** (migration 001-005) ไม่ใช่ของปัจจุบัน
migration 006-014 เพิ่มและแก้ไปอีกหลายอย่าง ของจริงดูที่ `db/migrations/`

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
- คิดเงิน / ยกเลิกบิล

สมาชิกทั่วไปสามารถ:

- Create Game (ใครในกลุ่มก็เปิดได้ แต่เปิดได้เฉพาะตอนที่กลุ่มยังไม่มีรอบ `open`)
- Join
- Leave
- List Players
- ถามข้อมูลรอบตี

ปุ่มยืนยัน / ปุ่ม wizard:

- คนกดต้องเป็นคนที่ขอ (`pending_actions.requested_by`)
- ต้องกดในกลุ่มเดียวกับที่ขอ
- ต้องทำกับ **รอบเดียวกับที่ออกการ์ดไว้** (`pending_actions.game_id`)
  ถ้ารอบนั้นถูกปิดหรือยกเลิกไปแล้ว การ์ดใบเก่าต้องใช้ไม่ได้ ห้ามไปทำกับรอบใหม่ที่เพิ่งเปิด
- กดไม่ผ่านเงื่อนไขข้างบน → ไม่มีผลอะไรและบอทไม่ตอบ (§23)

| การกระทำ | ใครทำได้ |
|---|---|
| ลงชื่อแทนคนอื่น / พาแขกมา | ทุกคนในกลุ่ม |
| ถอนชื่อคนอื่น | เจ้าตัว หรือคนที่ลงชื่อให้ (§13) |
| คิดเงินของรอบตี | คนเปิดรอบ |
| สร้างบิลลอย ๆ ที่ไม่ผูกกับรอบ | ทุกคนในกลุ่ม — ถามเลขพร้อมเพย์ของคนสร้างเสมอ |
| ยกเลิกบิล | คนที่สร้างบิลใบนั้น |
| บันทึกการจ่าย | เจ้าตัว, คนที่พาแขกคนนั้นมา, หรือคนที่สร้างบิล |

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
5. Check Wake Word (เฉพาะ message) — ไม่มี wake word ก็ยังเข้า Router ได้
   ถ้าบอทรอคำตอบอยู่ หรือคนนั้นอยู่ในโหมดฟัง (§6)
6. ส่งเข้า Router (§18)
7. Reply ผ่าน LINE Reply API (ใช้ `replyToken`)
8. คืน HTTP 200 เสมอเมื่อ signature ถูกต้อง (error ภายในให้ log และตอบ User แทน)

หมายเหตุ:

- `replyToken` ใช้ได้ครั้งเดียวและมีอายุสั้น ต้องตอบให้เสร็จเร็ว (Gemini timeout ดู `docs/llm-design.md`)
- Reply API ส่งได้สูงสุด 5 message ต่อครั้ง ถ้าเกินต้องตัดก่อนส่ง ไม่ปล่อยให้ LINE ปฏิเสธทั้งชุด
- รับได้สูงสุด 10 event ต่อ 1 request และทำทีละ 5 event พร้อมกัน
  เพื่อไม่ให้ handler ใช้เวลานานจน LINE ถือว่า timeout แล้วส่งซ้ำด้วย replyToken ที่ใช้ไปแล้ว
- การตอบทุกอย่างในบทสนทนาใช้ **Reply API** ซึ่งฟรีไม่จำกัด
- **Push API** ใช้ที่เดียวคือสรุปประจำสัปดาห์ (§27.1) เพราะ cron ไม่มี `replyToken`
  Push มีโควตาจำกัดและนับตามจำนวนคนในกลุ่ม จึงห้ามเอาไปใช้ตอบบทสนทนาเด็ดขาด

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

| ใช้อะไร | กับอะไร |
|---|---|
| **Flex Message** | การ์ดทุกใบ: รอบตี, รายชื่อ, บิล, ใครยังไม่จ่าย, การ์ดยืนยันทุกแบบ และ**ทุกข้อความที่มีปุ่ม** (คำถาม wizard, เมนูแก้ไข, ทักทาย, เมนูช่วยเหลือ, Fallback) |
| Datetime picker | เลือกวันและเวลา (เป็นปุ่มหนึ่งในท้ายการ์ด) |
| ข้อความธรรมดา | ผลลัพธ์สั้น ๆ (ลงชื่อ, ถอนชื่อ, บันทึกการจ่าย), ข้อความ error และคำถามที่ต้องพิมพ์ตอบโดยไม่มีปุ่ม |

**ไม่ใช้ Buttons template และ Quick Reply**

- Quick Reply ไม่แสดงบน LINE PC และหายทันทีที่ใครก็ได้ในกลุ่มกด คนอื่นกดทีเดียวเจ้าของก็เสียปุ่มไปทั้งชุด
- Buttons template ใส่ไอคอนไม่ได้ และจำกัดข้อความไว้ที่ 160 ตัวอักษร

ปุ่มทุกปุ่มอยู่ท้ายการ์ด Flex (footer) เรียงแถวละ 2 ปุ่ม ปุ่มยืนยันพื้นเหลือง ปุ่มอื่นพื้นเทา
ปุ่มสร้างจาก box ที่ผูก action ไว้ ไม่ใช่ component `button` เพราะ `button` ใส่ได้แค่ข้อความ

## สี

การ์ดใช้ธีม Retro 80s จากพาเลต "Retro of the 80s" ค่าจริงอยู่ที่ `COLOR` ใน `src/line/flex.ts`

| สี | ใช้กับ |
|---|---|
| Teal `#00BF9C` | พื้นหัวการ์ด (ตัวหนังสือขาว), หัวข้อ, ไอคอน, ลิงก์ |
| เหลือง `#FFD814` | พื้นปุ่มยืนยัน ใช้เป็นพื้นเท่านั้น เพราะตัวหนังสือเหลืองบนพื้นขาวอ่านไม่ออก |
| ชมพู `#FA4E93` | คำเตือน และพื้นหัวการ์ดยืนยันการยกเลิก |
| น้ำเงิน `#3B46A4` | ตัวหนังสือหลัก และตัวหนังสือกับไอคอนบนปุ่ม |

## ไอคอน

การ์ด Flex ใช้ไอคอน **Font Awesome Free (solid)** แทนอีโมจิทั้งหมด ทั้งหัวการ์ด บรรทัดข้อมูล รายการในบิล และปุ่ม
อีโมจิหน้าตาต่างกันไปตามเครื่อง ส่วนไอคอนเหมือนกันทุกเครื่อง

- Flex โหลดฟอนต์เองไม่ได้ ไอคอนจึงเป็นไฟล์ PNG ขนาด 96×96 ที่ `public/icons/<รหัสสี>/<ชื่อ>.png` เช่น `public/icons/00bf9c/check.png`
  LINE โหลดจาก `https://bot-bad.vercel.app/icons/...` (HTTPS เท่านั้น ไฟล์ต้อง deploy แล้วถึงจะขึ้น)
- มี 4 สี: `white` (บนหัวการ์ด), `ink` (บนปุ่ม), `accent` (ข้อมูลทั่วไป), `warn` (คำเตือน) สีติดมากับรูป
- โฟลเดอร์ตั้งชื่อตามรหัสสี เพราะ LINE แคชรูปตาม URL ถ้าเปลี่ยนสีแต่ URL เดิม คนในกลุ่มจะยังเห็นไอคอนสีเก่า
  เปลี่ยนค่าใน `COLOR` แล้วต้องสร้างไฟล์ชุดใหม่ในโฟลเดอร์ของรหัสสีนั้นให้ครบทุกชื่อ (มีเทสตรวจ)
- รายชื่อไอคอนที่ใช้อยู่ที่ `ICON_NAMES` ใน `src/line/flex.ts` ที่เดียว เพิ่มชื่อแล้วต้องมีไฟล์ครบทุกสี (มีเทสตรวจ)
- `icon` ของ Flex วางได้เฉพาะใน box แบบ `baseline` และ baseline มีลูกได้แค่ `icon` กับ `text`
- LINE วางขอบล่างของไอคอนไว้บน baseline ของตัวหนังสือ ไอคอนจึงลอยสูงกว่ากลางตัวอักษรไทย
  ทุกไอคอนกดลง 3px ด้วย `offsetTop` (ลูกของ baseline ใช้ `offsetBottom` ไม่ได้)
- Font Awesome Free ไม่มีไอคอนแบดมินตัน ใช้ `table-tennis-paddle-ball` แทน
- ปุ่มที่เป็นตัวเลขล้วน (จำนวนคอร์ท, เวลา, จำนวนเงิน) ไม่มีไอคอน เพราะจะได้ไอคอนเดียวกันซ้ำทุกปุ่ม
- ไอคอนใช้สัญญาอนุญาต CC BY 4.0 ต้องเก็บ `public/icons/LICENSE.txt` ไว้

ข้อความธรรมดาใส่รูปไม่ได้ จึงยังใช้อีโมจิเหมือนเดิม
ตัวอย่างการ์ดในเอกสารนี้ใช้อีโมจิแทนไอคอนเพื่อให้อ่านง่าย

ข้อควรระวังของ Flex: ข้อความใน Flex **ไม่กลายเป็นลิงก์ให้อัตโนมัติ** เหมือนข้อความธรรมดา
ลิงก์แผนที่จึงต้องผูก `uri` action เข้ากับบรรทัดนั้นเอง

ไม่ต้องสร้าง Web UI สำหรับ MVP

## คิดเงิน

`บอทจ๋า คิดเงิน` เฉย ๆ ไม่บอกว่าเงินเรื่องไหน บอท**ถามก่อนทุกครั้ง** ไม่เดาว่าเป็นค่ารอบ
เพราะหลังตีเสร็จก๊วนก็คิดค่ากินข้าวกันด้วย ถ้าเดาผิดต้องตอบค่าคอร์ทไปหลายขั้นถึงจะรู้ตัว
หรือเจอ "ยังไม่มีใครลงชื่อ เลยหารไม่ได้" ทั้งที่อยากสร้างบิลอื่น

```text
┌ คิดเงินอะไรดี? ──────────────────┐
│ 🏓 รอบ ศุกร์ 18 ก.ย. · คอร์ทสามย่าน │
│ [คิดค่ารอบ]     [สร้างบิลใหม่]     │
│ [แก้บิลเดิม]                      │
└──────────────────────────────────┘
```

| ปุ่ม | ขึ้นเมื่อ | กดแล้ว |
|---|---|---|
| คิดค่ารอบ | มีรอบเปิดอยู่ คนสั่งเป็นคนเปิดรอบ และมีคนลงชื่อแล้ว | ค่าคอร์ท → ลูกแบด → ค่าอื่น ๆ → การ์ดยืนยัน |
| สร้างบิลใหม่ | ทุกครั้ง | ขอชื่อบิลกับรายการ พิมพ์มาอิสระให้ Gemini แปลง → เลขพร้อมเพย์ → การ์ดยืนยัน |
| แก้บิลเดิม | คนสั่งมีบิลที่ตัวเองสร้างและยังเปิดอยู่ | เลือกบิล → เพิ่ม/ลบรายการ → การ์ดยืนยัน |

- ปุ่มที่ใช้ไม่ได้ไม่ขึ้น แต่บอกเหตุผลใต้คำถาม เช่น "รอบ ศุกร์ 18 ก.ย. ยังไม่มีใครลงชื่อ เลยยังคิดค่ารอบไม่ได้"
- เหลือทางเดียว (สร้างบิลใหม่) ไปทางนั้นเลยพร้อมบอกเหตุผล ไม่ขึ้นการ์ดที่มีปุ่มเดียว
- `บอทจ๋า คิดเงิน <ชื่อบิล>` คือสร้างบิลใหม่ชื่อนั้นเลย ไม่ต้องผ่านการ์ด
- Gemini เจอประโยคที่ไม่ชัดว่าเงินเรื่องไหน เช่น "คิดเงินหน่อย" เรียก `start_bill` ได้การ์ดเดียวกัน

**สร้างบิลใหม่** ให้พิมพ์ชื่อบิลกับรายการมาในข้อความเดียว บรรทัดละรายการ แล้ว Gemini แปลงเป็นบิล

```text
บิล ร้านโชคดี
- ค่าข้าว 1500 คิด วิท ฮก กิ๊ฟ
- ค่าน้ำ 100 คิด ฮก วิท
```

- ข้อความถัดไปของคนสั่งมาที่บิลนี้ก่อนอย่างอื่น (`awaiting = bill_freeform`) จึงไม่หลุดไปเป็นคำสั่ง `บิล`
- พิมพ์ "ไม่เอาแล้ว" / "พอแล้ว" = เลิกสร้าง คำรับคำสั้น ๆ ไม่นับเป็นรายการและไม่เสียโควตา LLM
- ไม่มี Gemini: ต้องใช้ `บอทจ๋า คิดเงิน <ชื่อบิล>` แล้วตอบทีละขั้นแบบเดิม

**เลขพร้อมเพย์** บิลลอย ๆ ไม่มีรอบให้ดึงเลข จึงถามคนสร้างบิลก่อนขึ้นการ์ดยืนยันเสมอ (ข้ามได้)
ปุ่มลัดเสนอเลขที่**คนสร้างบิลเคยใช้เอง** (จากบิลหรือรอบที่เขาสร้าง) ไม่ใช่เลขล่าสุดของกลุ่ม
ไม่งั้นเงินจะไปเข้าบัญชีคนที่ไม่ได้สร้างบิล การ์ดยืนยันขึ้นเลขให้ตรวจก่อนกดส่งด้วย

**แก้บิลเดิม** ทำได้เฉพาะคนสร้างบิล และเฉพาะบิลที่ยังเปิดอยู่

- การ์ดแก้บิลแสดงบิลหลังแก้: รายการใหม่มีป้าย "(ใหม่)" รายการที่จะลบขีดฆ่าไว้ ยอดรวมบอกของเดิมด้วย
- เพิ่มรายการ = พิมพ์รูปแบบเดียวกับตอนสร้างบิล บรรทัดละรายการ ไม่ใส่ชื่อ = เก็บทุกคนในบิลตอนนี้
- ลบรายการ = กดเลือกจากรายการ ลบจนไม่เหลือรายการไม่ได้ (ต้องยกเลิกบิลแทน)
- ยังไม่ได้แก้อะไร ยังไม่มีปุ่มยืนยัน
- กดยืนยันแล้วคิดยอดใหม่ด้วยสูตรเดียวกับตอนสร้างบิล
  - ยอดเท่าเดิม → สถานะการจ่ายเหมือนเดิม
  - ยอดเปลี่ยน → กลับเป็นยังไม่จ่าย เพราะที่บอกว่าจ่ายไปไม่ใช่ยอดนี้แล้ว
  - ไม่เหลือรายการไหน → ออกจากบิล พร้อมบันทึกการจ่ายของคนนั้น
  - การ์ดเตือนไว้ก่อนกดว่าใครจะกลับเป็นยังไม่จ่าย และใครจ่ายแล้วแต่จะหลุดจากบิล
- บิลที่สร้างก่อน migration 013 เก็บรายการไว้ใน jsonb แก้ไม่ได้ ต้องยกเลิกแล้วสร้างใหม่

## กติกาการแนบปุ่ม

บอทแนบปุ่มได้ **3 กรณีเท่านั้น**

1. **กำลังถาม** เพื่อเดิน wizard ต่อ (กี่คอร์ท? กี่โมง? ค่าคอร์ทเท่าไหร่?)
2. **ขอให้กดยืนยัน** (`confirm` / `reject`)
3. **ทักทายหรือ Fallback** ที่บอทรอคำสั่งอยู่ (เรียก `บอทจ๋า` เฉย ๆ, ตีความไม่ออก)

**ผลลัพธ์ของทุก action เป็นข้อความล้วน** ไม่ว่าจะเป็นลงชื่อ ถอนชื่อ รายชื่อ เปิดรอบสำเร็จ
แก้ไขสำเร็จ การ์ดบิล บันทึกการจ่าย ปิดรอบ ยกเลิก หรือข้อความ error

เหตุผล: ข้อความของบอทไปโผล่ในแชทของทั้งกลุ่ม ถ้าแนบปุ่มทุกครั้งที่มีคนขยับ
กลุ่มจะเต็มไปด้วยปุ่มที่ไม่มีใครกด และกลบบทสนทนาจริงของก๊วน
คนที่อยากลงชื่อหรือบอกว่าจ่ายแล้วพิมพ์สั่งเองได้อยู่แล้ว

ผลตามมา: postback `join` / `leave` / `list` / `bill_paid` / `bill_unpaid` / `bill_status`
ยังต้องทำงานได้ เพราะปุ่มที่ส่งไปแล้วยังค้างในแชทและถูกกดได้เสมอ (§10)

## กดปุ่มแย่งกัน

LINE แก้หรือลบข้อความที่ส่งไปแล้วไม่ได้ ปุ่มจึงค้างอยู่ให้ทุกคนในกลุ่มเห็นและกดได้
แทนที่จะพยายามทำให้ปุ่มหายไป บอททำให้การกดที่ไม่ควรมีผล **ไม่มีผลและไม่มีเสียง**:

- กดปุ่มของคนอื่น (`NOT_REQUESTER`) หรือปุ่มที่ใช้ไปแล้ว/หมดอายุ (`PENDING_EXPIRED`) → บอทไม่ตอบอะไร
- ปุ่มไม่ตั้ง `displayText` การกดจึงไม่โพสต์ข้อความในนามคนกด
- ถ้าเป็นคำตอบที่พิมพ์มา (ไม่ใช่การกดปุ่ม) ยังตอบข้อความ error ตามปกติ

ข้อเสียที่ยอมรับ: เจ้าของที่กดปุ่มหลังหมดอายุ 10 นาทีจะไม่ได้คำเตือน ต้องสั่งใหม่เอง
เพราะระบบแยกไม่ออกว่าปุ่มหมดอายุหรือถูกใช้ไปแล้ว (แถวที่ใช้แล้วถูกลบตอนสร้างรายการใหม่)

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
| `GAME_LIMIT_REACHED` | `⛔ กลุ่มนี้เปิดรอบไว้ครบ 3 รอบแล้ว` พร้อมรายการรอบ และบอกให้ปิดหรือยกเลิกรอบเดิมก่อน |
| `ALREADY_JOINED` | `ℹ️ คุณลงชื่อรอบนี้ไปแล้ว` |
| `NOT_JOINED` | `ℹ️ คุณยังไม่ได้ลงชื่อรอบนี้` |
| `GAME_FULL` | `⛔ รอบนี้เต็มแล้ว` |
| `NOT_GAME_CREATOR` | `⛔ คุณไม่มีสิทธิ์แก้ไขรอบตีนี้` |
| `COURT_TOO_SMALL` | `❌ ไม่สามารถลดเหลือ N คอร์ทได้ ...` |
| `DATE_IN_PAST` | `❌ วันเวลานี้ผ่านไปแล้ว` |
| `NO_CHANGES` | `ℹ️ ไม่มีอะไรเปลี่ยนแปลง` |
| `PENDING_EXPIRED` | `⛔ ปุ่มนี้หมดอายุหรือถูกใช้ไปแล้ว` (มาจากการกดปุ่ม → ไม่ตอบ §23) |
| `NOT_REQUESTER` | `⛔ เฉพาะคนที่สั่งเท่านั้นที่กดปุ่มนี้ได้` (มาจากการกดปุ่ม → ไม่ตอบ §23) |
| `NOT_YOUR_GUEST` | `⛔ ถอนได้เฉพาะตัวเอง กับคนที่คุณลงชื่อให้` |
| `PERSON_NOT_FOUND` | `❓ ไม่รู้จัก "<ชื่อ>" ในกลุ่มนี้` |
| `PERSON_AMBIGUOUS` | `❓ มีหลายคนชื่อ "<ชื่อ>" ระบุให้ชัดกว่านี้` |
| `BILL_AMBIGUOUS` | `❓ ตอนนี้มีบิลค้างอยู่หลายใบ` พร้อมรายชื่อใบที่เลือกได้ ตัวอย่างเป็นคำสั่งเดิมของคนพิมพ์ต่อด้วยชื่อบิล |
| `BILL_TITLE_TAKEN` | `⛔ มีบิลชื่อ "<ชื่อ>" เปิดอยู่แล้ว` ตั้งชื่ออื่นได้เลย |
| `NOTHING_OWED` | `ℹ️ <ชื่อ> ไม่มีบิลค้างจ่ายแล้วครับ` |
| `NOTHING_PAID` | `ℹ️ ยังไม่มีบิลไหนที่บันทึกว่า <ชื่อ> จ่ายแล้วครับ` |
| `ALL_BILLS_SETTLED` | `✅ ทุกบิลจ่ายครบแล้วครับ` |
| `INTERNAL_ERROR` | `😵 ระบบขัดข้อง ลองใหม่อีกครั้งนะ` |

Code ที่ใช้เฉพาะใน LLM Tool Result (ไม่แสดงให้ User โดยตรง): `MISSING_FIELDS`, `INVALID_ARGUMENT`, `INVALID_TOOL`

## LLM Fallback

เมื่อ Gemini error / timeout / โควตาหมด (429) / ตอบผิดรูปแบบ:

```text
🤔 ผมยังไม่เข้าใจประโยคนี้ครับพี่

ลองเลือกจากด้านล่างได้เลย
```

ปุ่มท้ายการ์ด:

```text
[ เปิดตี ]   [ ลงชื่อ ]
[ ถอนชื่อ ] [ ใครตีบ้าง ]
```

Rule-based และ Postback ต้องทำงานได้ปกติแม้ Gemini ใช้ไม่ได้

---

# 27. Free-First Requirement

เป้าหมาย MVP:

```text
Hosting       → Free
Database      → Free
LLM           → Free Tier
LINE          → Reply API ฟรีไม่จำกัด · Push API มีโควตา (§27.1)
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

ข้อยกเว้นเดียว: **Vercel Cron วันละครั้ง** เรียก `GET /api/cron/daily` เพื่อไม่ให้โปรเจค Supabase แบบ Free
ถูก pause จากการไม่มีการใช้งาน (Hobby รันได้วันละครั้ง ไม่มีค่าใช้จ่าย)

ของที่หมดอายุ (`pending_actions`, `conversation_sessions`) ลบทิ้งตอนเขียนรายการใหม่ ไม่ต้องมี job แยก

## 27.1 โควตา Push ของ LINE

สรุปประจำสัปดาห์ (§27.2) เป็นสิ่งเดียวในระบบที่ **ไม่ฟรีไม่จำกัด**

> "The number of messages is counted by the number of people you send a message to"
> — [Messaging API pricing](https://developers.line.biz/en/docs/messaging-api/pricing/)

ส่งเข้ากลุ่ม 30 คนครั้งเดียว = **ตัดโควตา 30 ข้อความ** ไม่ใช่ 1

โควตาจริงของบัญชีนี้ถามจาก LINE ได้โดยไม่เสียโควตา:

```text
GET /v2/bot/message/quota              → {"type":"limited","value":300}
GET /v2/bot/message/quota/consumption  → {"totalUsage":0}
```

| ขนาดกลุ่ม | ยิงสัปดาห์ละครั้ง (4.3 วัน/เดือน) |
|---|---|
| 30 คน | 129 จาก 300 (43%) |
| 50 คน | 215 (72%) |
| ~69 คน | 297 (เพดาน) |

`PUSH_QUOTA_STOP_AT` (ค่าเริ่มต้น 0.8) คือสัดส่วนที่ใช้ไปแล้วบอทจะหยุดส่งเอง
หยุดแล้วต้อง log ให้ดัง ไม่ใช่เงียบ

## 27.2 สรุปประจำสัปดาห์

**ทุกวันศุกร์ 10:00–10:59 เวลาไทย** (Vercel Hobby คลาดได้ ±59 นาที ห้ามสัญญาว่าตรงเวลา)

cron ยิง **ทุกวัน** แต่ push เฉพาะวันศุกร์

```text
ทุกวัน   → แตะฐานข้อมูล กัน Supabase pause + ปิดรอบที่วันเล่นผ่านไปแล้ว (§7)
วันศุกร์  → ปิดรอบก่อน แล้วค่อย push กลุ่มที่มีเรื่องจะบอก
```

ปิดรอบไม่สำเร็จแค่ log ไว้ พรุ่งนี้ cron ปิดให้อีกรอบ และต้องไม่ทำให้สรุปวันศุกร์ไม่ได้ส่ง

ที่ไม่ตั้ง cron เป็นรายสัปดาห์ไปเลย เพราะ Supabase pause เมื่อไม่มีการใช้งานครบ 7 วัน
ซึ่งเท่ากับระยะห่างของ cron รายศุกร์พอดี บวกความคลาด ±59 นาทีแล้วอาจหลุด

| เรื่อง | เงื่อนไข |
|---|---|
| รอบที่เปิดอยู่ | บอกทุกรอบ วัน เวลา คอร์ท และจำนวนคนที่ลงแล้ว — ไม่ว่าจะตีวันไหน |
| บิลค้าง | บอกจำนวนใบและยอดที่ยังไม่ได้รับ **ห้ามบอกชื่อคน** |
| ไม่มีอะไรเลย | **ไม่ push** ไม่ทักทาย ไม่ชวนเปิดรอบ |

กันส่งซ้ำด้วยตาราง `group_digests` ซึ่ง "จอง" สิทธิ์ส่งของวันนั้นในคำสั่งเดียวกับที่เช็ก
ไม่ใช่เช็กแล้วค่อยเขียนทีหลัง ซึ่งมีช่องให้ส่งสองรอบ

---

# 28. MVP Scope

## Must Have

- [x] LINE Webhook (message, postback, join)
- [x] Wake Word `บอทจ๋า`
- [x] โหมดฟัง (เรียกครั้งเดียว สั่งต่อได้ไม่ต้องเรียกชื่ออีก)
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
- [x] ปุ่มท้ายการ์ด Flex พร้อมไอคอน Font Awesome (เลิกใช้ Buttons template / Quick Reply)
- [x] การ์ดธีมสี Retro 80s และไอคอนอยู่กลางบรรทัด (§23)
- [x] "คิดเงิน" ถามก่อนว่าเงินเรื่องไหน: คิดค่ารอบ / สร้างบิลใหม่ / แก้บิลเดิม (§23)
- [x] สร้างบิลใหม่ด้วยการพิมพ์รายการมาอิสระ และถามเลขพร้อมเพย์ของคนสร้างบิล (§23)
- [x] แก้บิลที่ส่งไปแล้ว เพิ่มหรือลบรายการ (§23)
- [x] กดปุ่มของคนอื่นหรือปุ่มที่ใช้แล้ว → บอทเงียบ
- [x] LINE Flex Message (การ์ดรอบตี, รายชื่อ, บิล และการ์ดยืนยันทุกใบ)
- [x] เลขพร้อมเพย์ของรอบตี (ตั้งตอนเปิดรอบ / แก้ทีหลังได้)
- [x] คิดเงินและหารค่าใช้จ่ายต่อรอบ (ค่าคอร์ท / ลูกแบด / ค่าอื่น ๆ หารเท่า)
- [x] บันทึกว่าใครจ่ายแล้ว / ยังไม่จ่าย และเตือนตอนปิดรอบ
- [x] ลงชื่อ / ถอนชื่อแทนกัน และพาแขกที่ไม่ได้อยู่ในกลุ่มมาได้
- [x] บิลแยกจากรอบตี หลายใบพร้อมกัน แยกด้วยชื่อบิล
- [x] แต่ละรายการในบิลเลือกได้ว่าเก็บใครบ้าง
- [x] จ่ายแทนกันได้ (แขกพิมพ์เองไม่ได้ ต้องมีคนกดแทน)
- [x] สรุปประจำสัปดาห์เข้ากลุ่มทุกวันศุกร์ (§27.2)

รายละเอียดของสามข้อแรกอยู่ใน `docs/PRP/bill-splitting.md`
ส่วนหกข้อล่างอยู่ใน `docs/PRP/guests-split-bills-and-digest.md`

## Not in MVP

- [ ] Payment (บอทไม่รับ-ส่งเงินจริง ไม่ผูกบัญชีธนาคาร เป็นแค่กระดานจดว่าใครจ่ายแล้ว)
- [ ] ตรวจสอบสลิปโอนเงิน (ไม่มีผู้ให้บริการรายไหนฟรี)
- [ ] ทวงเป็นรายบุคคล (เป็น push รายคน กินโควตาเท่ากับส่งเข้ากลุ่ม §27.1)
- [ ] เตือนทุกวัน (สัปดาห์ละครั้งพอ และประหยัดโควตา 3-4 เท่า)
- [ ] ยอดค้างข้ามบิล / ledger รวม
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
23. คิดเงิน + หารค่าใช้จ่าย + บันทึกการจ่าย ✅ (เหลือฝั่งภาษาธรรมชาติ)
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

ตีเมื่อไหร่?

↓

เลือก "พรุ่งนี้ 19:00"

↓

Bot:

เล่นกี่ชั่วโมง?

↓

เลือก 2 ชั่วโมง

↓

Bot:

ที่เดิมไหม?   (ก๊วนที่ยังไม่เคยเปิดรอบ จะถูกถามชื่อคอร์ท แผนที่ และพร้อมเพย์แทน)

↓

เลือก "ที่เดิม"

↓

Bot:

ยืนยัน?

↓

เปิดตี

↓

🏸 เปิดรอบตีแล้ว

ABC Badminton
📅 พรุ่งนี้
⏰ 19:00 - 21:00
🏸 1 คอร์ท
👥 0/8 คน

↓

สมาชิกพิมพ์ "บอทจ๋า ลงชื่อ"

↓

✅ ลงชื่อแล้ว 👥 1/8 คน

↓

สมาชิกคนอื่นลงชื่อจนครบ

↓

👥 8/8 คน

↓

คนที่ 9 ลงชื่อ

↓

⛔ รอบนี้เต็มแล้ว
```

และต้องทำได้ด้วย:

- `บอทจ๋า พรุ่งนี้สองทุ่มเปิดตี 2 คอร์ท 2 ชั่วโมง` → การ์ดยืนยัน → เปิดรอบได้
- `บอทจ๋า พรุ่งนี้สองทุ่มเปิดตี` → บอทถามจำนวนคอร์ทและชั่วโมง → ตอบต่อได้
- `บอทจ๋า คืนนี้ผมไปด้วย` → ลงชื่อสำเร็จ
- เปิดรอบซ้ำตอนมีรอบ open → ถูก reject
- คนที่ไม่ใช่ผู้สร้างสั่งแก้ไข / ยกเลิก / ปิดรอบ → ถูก reject
- คนอื่นกดปุ่มยืนยันของคนอื่น → ไม่มีผล และบอทไม่ตอบ
- ปุ่มทุกปุ่มกดได้ทั้งบนมือถือและ LINE PC
- ผู้สร้างแก้ไข ยกเลิก และปิดรอบได้
- ปิด `GEMINI_API_KEY` แล้ว rule-based ยังทำงาน และข้อความภาษาธรรมชาติได้ Fallback
- ทุกข้อความที่ไม่ได้ขึ้นต้นด้วย `บอทจ๋า` ถูก ignore
- `บอทจ๋า เมนู` → เห็นรายการคำสั่งทั้งหมด
- ผลลัพธ์ของทุก action ไม่มีปุ่มติดมาด้วย (§23)

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
message must start with "บอทจ๋า"
exempt: postback from bot buttons, an answer the bot is waiting for,
and messages from the person who just called the bot while the 2-minute
listening window is open (same group, that person only)

Listening window:
silence is the default — if the message cannot be understood, say nothing

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
