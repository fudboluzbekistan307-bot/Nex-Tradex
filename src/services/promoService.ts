import { pool } from "../db/pool";

/**
 * GURUH VA KANALLARDA AVTOMATIK REKLAMA (v5)
 *
 * - Bot guruh yoki kanalga qo'shilganda chat eslab qolinadi va darhol
 *   birinchi reklama yuboriladi.
 * - Keyin har interval_minutes (standart 10 daqiqa) da rasm + matn + tugma.
 * - Guruhni to'ldirib yubormaslik uchun yangi reklamadan oldin botning
 *   OLDINGI reklamasi o'chiriladi (PROMO_DELETE_PREVIOUS=false - o'chirmaslik).
 * - Guruh adminlari: /reklama_vaqt 30 (daqiqa), /reklama_stop, /reklama_start
 * - Bot egasi (ADMIN): /reklama_matn, /reklama_rasm (rasmga reply), /reklama_hozir, /reklamalar
 * - Bot chiqarib yuborilsa yoki yozish huquqi olinsa - avtomatik to'xtaydi.
 */

export const DEFAULT_PROMO_TEXT =
  "📈 Tasavvur qiling, o'z tokeningiz bor va uning narxi har 10 soniyada o'zgaradi!\n\n" +
  "🎮 NexTrade — Telegram ichidagi mutlaqo bepul birja o'yini!\n\n" +
  "🎁 Hozir kirsangiz, sizga biryo'la 100 Nex start bonusi beriladi.\n" +
  "O'z strategiyangizni sinang, do'stlarni taklif qiling va haftalik ligada yetakchilik qiling!\n\n" +
  "🕹 Bu o'yin — real pul kerak emas.\n\n" +
  "👇 O'yinni hozir bosing va birinchi tokeningizni yarating:\n" +
  "🏆 @NexTradexbot";

export const MIN_INTERVAL_MINUTES = Number(process.env.PROMO_MIN_MINUTES ?? 10);
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const DEFAULT_INTERVAL = Number(process.env.PROMO_INTERVAL_MINUTES ?? 10);
const DELETE_PREVIOUS = process.env.PROMO_DELETE_PREVIOUS !== "false";

// ---------------- Sozlamalar ----------------

export async function getSetting(key: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT value FROM bot_settings WHERE key = $1", [key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string | null) {
  if (value === null) {
    await pool.query("DELETE FROM bot_settings WHERE key = $1", [key]);
    return;
  }
  await pool.query(
    `INSERT INTO bot_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

export async function getPromoText() {
  return (await getSetting("promo_text")) ?? DEFAULT_PROMO_TEXT;
}

// ---------------- Chatlar ----------------

export async function registerChat(chatId: number, title: string | undefined, type: string) {
  await pool.query(
    `INSERT INTO promo_chats (chat_id, title, chat_type, is_active, interval_minutes)
     VALUES ($1, $2, $3, true, $4)
     ON CONFLICT (chat_id) DO UPDATE SET title = $2, chat_type = $3, is_active = true`,
    [chatId, title ?? null, type, DEFAULT_INTERVAL]
  );
}

export async function deactivateChat(chatId: number) {
  await pool.query("UPDATE promo_chats SET is_active = false WHERE chat_id = $1", [chatId]);
}

export async function setChatActive(chatId: number, active: boolean) {
  const { rowCount } = await pool.query("UPDATE promo_chats SET is_active = $2 WHERE chat_id = $1", [chatId, active]);
  return Boolean(rowCount);
}

export async function setChatInterval(chatId: number, minutes: number) {
  const m = Math.round(minutes);
  if (!(m >= MIN_INTERVAL_MINUTES && m <= MAX_INTERVAL_MINUTES)) {
    throw new Error(`Oraliq ${MIN_INTERVAL_MINUTES} daqiqadan ${MAX_INTERVAL_MINUTES / 60} soatgacha bo'lishi kerak`);
  }
  const { rowCount } = await pool.query("UPDATE promo_chats SET interval_minutes = $2 WHERE chat_id = $1", [chatId, m]);
  if (!rowCount) throw new Error("Bu chat ro'yxatda yo'q. Botni guruhdan chiqarib, qayta qo'shing");
  return m;
}

/** "30", "30m", "2h", "2 soat", "45 daqiqa" -> daqiqa */
export function parseIntervalMinutes(input: string): number {
  const t = input.trim().toLowerCase();
  const n = parseFloat(t.replace(",", "."));
  if (!n) return 0;
  if (/(h|soat|час)/.test(t)) return Math.round(n * 60);
  return Math.round(n);
}

export function formatInterval(minutes: number) {
  if (minutes % 60 === 0) return `${minutes / 60} soat`;
  if (minutes > 60) return `${Math.floor(minutes / 60)} soat ${minutes % 60} daqiqa`;
  return `${minutes} daqiqa`;
}

export async function listPromoChats() {
  const { rows } = await pool.query(
    `SELECT chat_id, title, chat_type, is_active, interval_minutes, posts_sent, last_post_at
     FROM promo_chats ORDER BY is_active DESC, posts_sent DESC`
  );
  return rows;
}

// ---------------- Yuborish ----------------

export interface PromoSender {
  sendPhoto(chatId: number, photo: string, caption: string, button: { text: string; url: string }): Promise<{ fileId?: string; messageId?: number }>;
  sendText(chatId: number, text: string, button: { text: string; url: string }): Promise<{ messageId?: number }>;
  deleteMessage?(chatId: number, messageId: number): Promise<void>;
}

function botLink() {
  return `https://t.me/${process.env.BOT_USERNAME ?? "NexTradexbot"}?start=promo`;
}

/** Rasm manbai: avval saqlangan file_id (tez), bo'lmasa serverdagi promo.jpg. */
async function photoSource(): Promise<string | null> {
  const fileId = await getSetting("promo_photo_file_id");
  if (fileId) return fileId;
  const base = (process.env.WEBHOOK_URL ?? process.env.RENDER_EXTERNAL_URL ?? process.env.MINI_APP_URL ?? "").replace(/\/+$/, "");
  return base.startsWith("https://") ? `${base}/promo.jpg` : null;
}

/**
 * Bitta chatga reklama yuboradi. Xato bo'lsa (bot chiqarilgan, huquq yo'q)
 * chat o'chiriladi. true - yuborildi.
 */
export async function sendPromoToChat(chatId: number, sender: PromoSender): Promise<boolean> {
  const text = await getPromoText();
  const button = { text: "🚀 O'yinni boshlash", url: botLink() };
  try {
    // Oldingi reklamani o'chiramiz - guruhda doim faqat bitta (eng yangi) reklama turadi
    if (DELETE_PREVIOUS && sender.deleteMessage) {
      const prev = await pool.query("SELECT last_message_id FROM promo_chats WHERE chat_id = $1", [chatId]);
      const prevId = Number(prev.rows[0]?.last_message_id ?? 0);
      if (prevId) await sender.deleteMessage(chatId, prevId).catch(() => {});
    }

    const photo = await photoSource();
    let messageId: number | undefined;
    if (photo) {
      const r = await sender.sendPhoto(chatId, photo, text.slice(0, 1024), button);
      messageId = r.messageId;
      // Telegram qaytargan file_id ni saqlab qo'yamiz - keyingi safar rasm qayta yuklanmaydi
      if (r.fileId && !(await getSetting("promo_photo_file_id"))) await setSetting("promo_photo_file_id", r.fileId);
    } else {
      messageId = (await sender.sendText(chatId, text, button)).messageId;
    }
    await pool.query(
      "UPDATE promo_chats SET last_post_at = NOW(), posts_sent = posts_sent + 1, last_message_id = $2 WHERE chat_id = $1",
      [chatId, messageId ?? null]
    );
    return true;
  } catch (err: any) {
    const code = err?.error_code;
    const desc = String(err?.description ?? err?.message ?? "");
    // 403: chiqarib yuborilgan / bloklangan; 400: chat topilmadi yoki yozish huquqi yo'q
    if (code === 403 || (code === 400 && /chat not found|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|kicked/i.test(desc))) {
      await deactivateChat(chatId);
      console.log(`ℹ️ Reklama: chat ${chatId} o'chirildi (${desc})`);
    } else {
      console.error(`⚠️ Reklama yuborilmadi (${chatId}):`, desc);
    }
    return false;
  }
}

/** Vaqti kelgan chatlarga reklama yuboradi (har 10 daqiqada chaqiriladi). */
export async function runPromoCycle(sender: PromoSender): Promise<number> {
  const { rows } = await pool.query(
    `SELECT chat_id FROM promo_chats
     WHERE is_active = true
       AND (last_post_at IS NULL OR last_post_at <= NOW() - (interval_minutes * INTERVAL '1 minute') + INTERVAL '30 seconds')
     ORDER BY last_post_at NULLS FIRST
     LIMIT 100`
  );
  let sent = 0;
  for (const r of rows) {
    if (await sendPromoToChat(Number(r.chat_id), sender)) sent++;
    await new Promise((res) => setTimeout(res, 200));
  }
  return sent;
}

let promoHandle: ReturnType<typeof setInterval> | null = null;
export function startPromoScheduler(sender: PromoSender) {
  if (promoHandle) return;
  const tick = () =>
    runPromoCycle(sender)
      .then((n) => n > 0 && console.log(`📢 Reklama ${n} ta chatga yuborildi`))
      .catch((err) => console.error("❌ Reklama siklida xato:", err));
  // Har daqiqada tekshiradi - har bir chat o'z oralig'i kelganda oladi
  promoHandle = setInterval(tick, 60 * 1000);
  setTimeout(tick, 30_000);
}
