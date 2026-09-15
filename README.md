# 🏸 Badminton LINE Bot

LINE Bot สำหรับจัดรอบตีแบดใน LINE Group

- Spec: `Badminton LINE Bot — MVP Specification.md`
- LLM: `LLM Design.md`
- กฎโปรเจค: `CLAUDE.md`

## สถานะ

- [x] Next.js + Webhook `POST /api/line/webhook`
- [x] ตรวจ LINE signature
- [x] Wake word `บอทจ๋า` + ใช้ในกลุ่มเท่านั้น
- [ ] Database / คำสั่งรอบตี / Gemini

ตอนนี้ถ้าพิมพ์ `บอทจ๋า` ในกลุ่ม บอทจะตอบข้อความชั่วคราวว่าพร้อมแล้ว

## Local Development

ต้องมี Node.js 20.9 ขึ้นไป

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
