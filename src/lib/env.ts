import { z } from "zod";

const lineEnvSchema = z.object({
  LINE_CHANNEL_SECRET: z.string().min(1),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1),
});

export type LineEnv = z.infer<typeof lineEnvSchema>;

// อ่าน env ตอนเรียกใช้ ไม่ใช่ตอน import เพื่อให้ next build ผ่านได้โดยไม่มี secrets
export function getLineEnv(): LineEnv {
  const parsed = lineEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Missing or invalid LINE environment variables: ${missing}`);
  }
  return parsed.data;
}
