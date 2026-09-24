import zlib from "zlib";
import { pool } from "../db/pool";
import { TABLES } from "../db/migrateFrom";
import { getSetting, setSetting } from "./promoService";

/**
 * KUNLIK ZAXIRA NUSXA (v6)
 * Har kecha (Toshkent vaqti bilan 03:00 dan keyin) butun baza siqilgan JSON
 * fayl qilib adminga Telegram orqali yuboriladi. Bepul baza o'chib ketsa ham
 * ma'lumot yo'qolmaydi. Tiklash: yangi (bo'sh) bazaga ulanib, botda shu faylga
 * reply qilib /tiklash yoziladi.
 */

const TZ = "Asia/Tashkent";

async function tableExists(table: string) {
  const { rows } = await pool.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${table}`]);
  return rows[0].ok as boolean;
}

/** Butun bazani JSON (gzip) ko'rinishida qaytaradi. JSON'ni PostgreSQL o'zi yasaydi - vaqtlar aniq saqlanadi. */
export async function createBackup(): Promise<{ buffer: Buffer; filename: string; counts: Record<string, number> }> {
  const parts: string[] = [];
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    if (!(await tableExists(t))) continue;
    const { rows } = await pool.query(
      `SELECT COALESCE(json_agg(x), '[]'::json)::text AS j, COUNT(*)::int AS n FROM (SELECT * FROM "${t}") x`
    );
    counts[t] = rows[0].n;
    parts.push(`${JSON.stringify(t)}:${rows[0].j}`);
  }
  const meta = await pool.query(`SELECT to_char(NOW() AT TIME ZONE '${TZ}', 'YYYY-MM-DD_HH24-MI') AS d`);
  const json = `{"format":"nextrade-backup-v1","created_at":${JSON.stringify(new Date().toISOString())},"tables":{${parts.join(",")}}}`;
  return {
    buffer: zlib.gzipSync(Buffer.from(json, "utf-8")),
    filename: `nextrade-backup-${meta.rows[0].d}.json.gz`,
    counts,
  };
}

/** Bugun zaxira olinmagan va soat 03:00 dan o'tgan bo'lsa - true. */
export async function isBackupDue(): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT to_char(NOW() AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS d, EXTRACT(HOUR FROM NOW() AT TIME ZONE '${TZ}')::int AS h`
  );
  if (rows[0].h < 3) return false;
  return (await getSetting("last_backup_date")) !== rows[0].d;
}

export async function markBackupDone() {
  const { rows } = await pool.query(`SELECT to_char(NOW() AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS d`);
  await setSetting("last_backup_date", rows[0].d);
}

/** Zaxira faylidan tiklash. Faqat bazada hali haqiqiy foydalanuvchi bo'lmasa ishlaydi. */
export async function restoreBackup(gz: Buffer): Promise<Record<string, number>> {
  const real = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE telegram_id > 0");
  if (real.rows[0].n > 0) {
    throw new Error("Bazada allaqachon foydalanuvchilar bor. Tiklash faqat BO'SH bazaga qilinadi (ma'lumotlar ustidan yozilmasligi uchun)");
  }
  let data: any;
  try {
    data = JSON.parse(zlib.gunzipSync(gz).toString("utf-8"));
  } catch {
    throw new Error("Fayl o'qilmadi. Bu NexTrade zaxira fayli (.json.gz) ekaniga ishonch hosil qiling");
  }
  if (data?.format !== "nextrade-backup-v1" || !data.tables) throw new Error("Noto'g'ri zaxira fayli");

  const client = await pool.connect();
  const counts: Record<string, number> = {};
  try {
    await client.query("BEGIN");
    const existing: string[] = [];
    for (const t of TABLES) if (await tableExists(t)) existing.push(t);
    await client.query(`TRUNCATE ${existing.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
    for (const t of existing) {
      const rows = data.tables[t];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      for (let i = 0; i < rows.length; i += 500) {
        await client.query(
          `INSERT INTO "${t}" SELECT * FROM json_populate_recordset(NULL::"${t}", $1::json)`,
          [JSON.stringify(rows.slice(i, i + 500))]
        );
      }
      const hasId = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'",
        [t]
      );
      if (hasId.rows.length) {
        await client.query(
          `SELECT setval(seq, COALESCE((SELECT MAX(id) FROM "${t}"), 0) + 1, false)
           FROM (SELECT pg_get_serial_sequence('"${t}"', 'id') AS seq) s WHERE seq IS NOT NULL`
        );
      }
      counts[t] = rows.length;
    }
    await client.query("COMMIT");
    return counts;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
