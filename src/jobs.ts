import { pool } from "./db/pool";
import { sendTelegramMessage, sendBackupToAdmin } from "./bot/bot";
import { processLaunches, sendReminders, payoutPreviousSeason } from "./services/retentionService";
import { announceText } from "./services/announceService";
import { isBackupDue } from "./services/backupService";

/**
 * FON VAZIFALARI (v6)
 *  - har daqiqa: IPO tokenlar savdosi ochilganda xabar
 *  - har soat: eslatmalar (faqat kunduzi 10:00-21:00), kunlik zaxira, oylik mavsum mukofoti
 */

async function tashkentHour(): Promise<number> {
  const { rows } = await pool.query("SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Tashkent')::int AS h");
  return rows[0].h;
}

async function minuteJobs() {
  try {
    const n = await processLaunches(sendTelegramMessage, announceText);
    if (n) console.log(`🚀 ${n} ta IPO token savdosi ochildi`);
  } catch (err) {
    console.error("❌ IPO ochilishida xato:", err);
  }
}

async function hourlyJobs() {
  try {
    const h = await tashkentHour();
    if (h >= 10 && h <= 21) {
      const n = await sendReminders(sendTelegramMessage);
      if (n) console.log(`🔔 ${n} ta eslatma yuborildi`);
    }
  } catch (err) {
    console.error("❌ Eslatmalarda xato:", err);
  }
  try {
    if (await isBackupDue()) {
      if (await sendBackupToAdmin()) console.log("💾 Kunlik zaxira adminga yuborildi");
    }
  } catch (err) {
    console.error("❌ Zaxirada xato:", err);
  }
  try {
    const n = await payoutPreviousSeason(sendTelegramMessage);
    if (n) console.log(`👑 Oylik mavsum: ${n} ta g'olib`);
  } catch (err) {
    console.error("❌ Mavsum mukofotida xato:", err);
  }
}

let started = false;
export function startJobs() {
  if (started) return;
  started = true;
  setInterval(minuteJobs, 60_000);
  setInterval(hourlyJobs, 60 * 60_000);
  setTimeout(hourlyJobs, 60_000);
}
