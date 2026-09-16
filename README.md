# 🏸 Badminton LINE Bot

LINE Bot สำหรับจัดรอบตีแบดใน LINE Group

- Spec: `Badminton LINE Bot — MVP Specification.md`
- LLM: `LLM Design.md`
- กฎโปรเจค: `CLAUDE.md`

## สถานะ

- [x] Next.js + Webhook `POST /api/line/webhook`
- [x] ตรวจ LINE signature
- [x] Wake word `บอทจ๋า` + ใช้ในกลุ่มเท่านั้น
- [ ] Router / คำสั่งรอบตี (spec §18)
- [ ] Database / Gemini

พฤติกรรมตอนนี้:

| เหตุการณ์ | บอททำอะไร |
|---|---|
| ถูกเชิญเข้ากลุ่ม | ทักทายและบอกว่ายังสั่งงานไม่ได้ |
| ในกลุ่ม พิมพ์ `บอทจ๋า ...` | ยังไม่ตอบ (รอ Router ตาม spec §18) |
| ในกลุ่ม ข้อความอื่น | ไม่ตอบ |
| แชท 1:1 หรือห้องแบบอื่น พิมพ์ `บอทจ๋า ...` | ตอบว่าใช้ได้ในกลุ่มเท่านั้น |

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
| `npm test` | รัน tests (ไม่เรียก LINE API จริง) |
| `npm run typecheck` | ตรวจ TypeScript |
| `npm run build` | build production |

ทดสอบ webhook กับ LINE จริงจากเครื่องตัวเอง ต้องเปิด tunnel (เช่น ngrok) แล้วเอา URL ไปใส่ใน LINE Console ชั่วคราว

## Environment Variables

| ชื่อ | ใช้ตอนนี้ |
|---|---|
| `LINE_CHANNEL_SECRET` | ✅ ตรวจ signature |
| `LINE_CHANNEL_ACCESS_TOKEN` | ✅ ส่ง reply |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | ยังไม่ใช้ |
| `DATABASE_URL` | ยังไม่ใช้ |

## Deploy (Vercel)

1. สร้างโปรเจคบน Vercel และตั้ง env `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` (Production)
2. Deploy
3. LINE Developers Console → Messaging API:
   - Webhook URL: `https://<vercel-domain>/api/line/webhook` → กด **Verify**
   - เปิด **Use webhook**
   - เปิด **Allow bot to join group chats**
4. LINE Official Account Manager → ปิด **Auto-response messages**
