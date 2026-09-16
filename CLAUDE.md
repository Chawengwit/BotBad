# 📜 Project Rules — Badminton LINE Bot

กฎของโปรเจคนี้ ใช้กับ AI CLI / AI Agent ทุกตัวที่ทำงานในโปรเจคนี้

Specification หลัก: `docs/specification.md`

---

## 1. ห้ามเริ่มเขียน Code ก่อนได้รับคำสั่ง

- ห้ามสร้าง / แก้ไข / ลบไฟล์ code ใด ๆ จนกว่าผู้ใช้จะสั่งให้เริ่มชัดเจน
- ห้ามรัน scaffold หรือติดตั้ง package (`npx create-next-app`, `npm install`, `pnpm add` ฯลฯ) ก่อนได้รับคำสั่ง
- ทำได้: อ่านไฟล์, วิเคราะห์, สรุป, เสนอแผน, ตอบคำถาม
- ถ้าไม่แน่ใจว่าได้รับอนุญาตแล้วหรือยัง → **ถามก่อน**

---

## 2. ห้ามใช้ Git ก่อนได้รับคำสั่ง

ห้ามรันคำสั่งที่เปลี่ยนแปลงสถานะ Git หรือ remote จนกว่าผู้ใช้จะสั่ง:

- `git commit`
- `git push`
- `git pull`
- `git merge`, `git rebase`, `git reset`, `git checkout` / `git switch` ที่เปลี่ยน branch หรือทิ้งการแก้ไข
- `git stash`, `git tag`, `git branch -d`
- สร้าง / แก้ไข / merge Pull Request (`gh pr ...`)

ทำได้ (อ่านอย่างเดียว):

- `git status`
- `git diff`
- `git log`
- `git show`

การอนุญาต 1 ครั้งใช้ได้กับคำสั่งนั้นครั้งเดียว ไม่ถือเป็นการอนุญาตถาวร

---

## 3. Database: อ่านได้อย่างเดียว

ห้ามเปลี่ยนแปลงข้อมูลหรือโครงสร้าง Database ใด ๆ จนกว่าผู้ใช้จะสั่ง

ห้าม:

- `CREATE` (table, index, schema, function, trigger ฯลฯ)
- `INSERT`
- `UPDATE`
- `DELETE`
- `ALTER`
- `DROP`
- `TRUNCATE`
- รัน migration / seed script
- เปลี่ยนแปลงผ่าน Supabase Dashboard, SQL Editor หรือ API

ทำได้:

- `SELECT` เพื่ออ่านข้อมูลเท่านั้น
- ดูโครงสร้างตาราง (`information_schema`, `\d`) เพื่ออ่าน

ก่อนรัน SQL ที่ไม่ใช่ `SELECT` ต้องแสดง SQL ให้ผู้ใช้ดูและรอคำสั่งยืนยันทุกครั้ง

---

## 4. หลักทั่วไป

- ถ้าคำสั่งไม่ชัดเจน → ถามก่อน อย่าเดา
- ทำเฉพาะสิ่งที่ถูกสั่ง ห้ามขยาย scope เอง
- ห้าม commit / แสดง secrets (`.env`, API key, token)
- ปฏิบัติตาม Specification หลักเสมอ ถ้าขัดกับกฎในไฟล์นี้ ให้ยึดกฎในไฟล์นี้
