import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL ?? "";

// Render'ning TASHQI (External) manzili (...render.com) SSL talab qiladi.
// Ichki (Internal) manzil (dpg-xxxx-a) esa SSL'siz ishlaydi.
const needsSsl = /render\.com|sslmode=require/i.test(DATABASE_URL);

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL o'rnatilmagan! Render → Environment bo'limida qo'shing");
} else {
  const host = DATABASE_URL.replace(/^.*@/, "").replace(/[:/].*$/, "");
  console.log(`🗄  Baza: ${host} (SSL: ${needsSsl ? "ha" : "yo'q"})`);
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
  // Avval bu cheklov yo'q edi: baza manzili noto'g'ri bo'lsa, so'rov
  // CHEKSIZ kutib qolardi (bot ham, API ham javob bermasdi, logda xato ham yo'q).
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  console.error("Kutilmagan baza xatosi:", err);
});
