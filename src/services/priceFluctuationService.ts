import { pool } from "../db/pool";
import { ABSOLUTE_MIN_PRICE } from "./pricingService";
import { tickNexTradePrice } from "./nexTradePriceService";
import { checkPriceAlerts } from "./alertService";

/**
 * Har TICK_INTERVAL_MS da barcha tokenlar narxiga kichik, tasodifiy tebranish
 * qo'shadi - xuddi real bozordagidek, savdo bo'lmasa ham narx ozgina
 * pasayib-ko'tarilib turadi.
 */

const TICK_INTERVAL_MS = 10_000; // 10 soniya
const MAX_TICK_CHANGE = 0.02; // bitta tikda maksimal ±2%

// Nex Trade - asosiy valyuta, shuning uchun barqarorroq (±0.5%)
const NEX_TRADE_MAX_TICK_CHANGE = 0.005;

// Eski grafik nuqtalarini tozalash. Avval price_ticks jadvali har 10 soniyada
// HAR BIR token uchun yozilib, hech qachon o'chirilmasdi - 50 ta token bo'lsa
// kuniga ~430 000 qator. Render bepul Postgres (1 GB) bir necha oyda to'lib
// qolardi. Grafik baribir faqat oxirgi 100 nuqtani ko'rsatadi.
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // soatda bir marta
const PRICE_TICK_RETENTION_DAYS = Number(process.env.PRICE_TICK_RETENTION_DAYS ?? 3);

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let cleanupHandle: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;

async function tickAllTokens() {
  // Oldingi tik hali tugamagan bo'lsa (baza sekin), ustma-ust ishga tushirmaymiz
  if (tickRunning) return;
  tickRunning = true;

  try {
    // XATOLIK TUZATILDI: avval narx avval o'qilib (SELECT), keyin alohida
    // yozilardi (UPDATE). Shu oraliqda kimdir savdo qilsa, savdo natijasidagi
    // yangi narx eski narx * tasodif bilan USTIDAN YOZILIB yo'qolardi.
    // Endi hammasi bitta atomar SQL buyrug'ida - savdo qulfini hurmat qiladi.
    await pool.query(
      `WITH upd AS (
         UPDATE tokens
         SET current_price = GREATEST(current_price * (1 + (random() * 2 - 1) * $1::numeric), $2::numeric)
         RETURNING id, current_price
       )
       INSERT INTO price_ticks (token_id, price)
       SELECT id, current_price FROM upd`,
      [MAX_TICK_CHANGE, ABSOLUTE_MIN_PRICE]
    );
  } catch (err) {
    console.error("❌ Avtomatik narx tebranishida xatolik:", err);
  }

  try {
    await tickNexTradePrice(NEX_TRADE_MAX_TICK_CHANGE);
  } catch (err) {
    console.error("❌ Nex Trade narx tebranishida xatolik:", err);
  }

  try {
    await checkPriceAlerts();
  } catch (err) {
    console.error("❌ Narx bildirishnomalarida xatolik:", err);
  }

  tickRunning = false;
}

export async function cleanupOldTicks() {
  try {
    const a = await pool.query(
      `DELETE FROM price_ticks WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [PRICE_TICK_RETENTION_DAYS]
    );
    const b = await pool.query(
      `DELETE FROM nex_trade_price_ticks WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [PRICE_TICK_RETENTION_DAYS * 2]
    );
    if ((a.rowCount ?? 0) + (b.rowCount ?? 0) > 0) {
      console.log(`🧹 Eski grafik nuqtalari o'chirildi: ${a.rowCount} + ${b.rowCount}`);
    }
  } catch (err) {
    console.error("❌ Eski narx nuqtalarini tozalashda xatolik:", err);
  }
}

export function startPriceFluctuations() {
  if (intervalHandle) return;
  intervalHandle = setInterval(tickAllTokens, TICK_INTERVAL_MS);
  cleanupHandle = setInterval(cleanupOldTicks, CLEANUP_INTERVAL_MS);
  cleanupOldTicks();
  console.log("✅ Avtomatik narx tebranishi ishga tushdi (har 10 soniyada)");
}

export function stopPriceFluctuations() {
  if (intervalHandle) clearInterval(intervalHandle);
  if (cleanupHandle) clearInterval(cleanupHandle);
  intervalHandle = null;
  cleanupHandle = null;
}
