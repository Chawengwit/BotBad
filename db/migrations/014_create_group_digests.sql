-- กันไม่ให้กลุ่มได้รับสรุปประจำสัปดาห์ซ้ำในวันเดียวกัน
-- (docs/PRP/guests-split-bills-and-digest.md §6.3)
--
-- cron ยิงซ้ำได้จากหลายเหตุ: Vercel retry, deploy ซ้ำ, หรือกดเรียกเอง
-- แถวนี้คือการ "จอง" สิทธิ์ส่งของวันนั้น ใครจองได้ก่อนเป็นคนส่ง
CREATE TABLE group_digests (
  line_group_id  TEXT PRIMARY KEY,
  last_sent_on   DATE NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
