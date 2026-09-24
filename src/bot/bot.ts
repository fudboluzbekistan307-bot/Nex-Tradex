import { Bot, InlineKeyboard } from "grammy";
import dotenv from "dotenv";
import { getOrCreateUser, getPlatformStats, getUserLeaderboard } from "../services/userService";
import { claimStreakBonus, getLeague, REFERRAL_REWARD } from "../services/engagementService";
import { listFrozenBalances, getTotalFrozen, withdrawFrozen } from "../services/frozenService";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
const MINI_APP_URL = process.env.MINI_APP_URL ?? "https://example.com";
const BOT_USERNAME = process.env.BOT_USERNAME ?? "your_bot";
const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID ?? "0");

// BOT_TOKEN bo'lmasa ham (masalan, lokal test) modul yiqilmasligi uchun
// soxta token bilan yaratiladi - index.ts bunday holda botni ishga tushirmaydi.
export const bot = new Bot(BOT_TOKEN || "0:missing-token");

/**
 * Bot buyruqlari ro'yxati va chap pastdagi "Menu" tugmasini Mini App'ga
 * bog'laydi - foydalanuvchi /start yozmasdan ham ilovani ocha oladi.
 */
export async function setupBotMenu() {
  await bot.api.setMyCommands([
    { command: "start", description: "🚀 NexTrade'ni ochish" },
    { command: "kunlik", description: "🔥 Kunlik bonus (seriya)" },
    { command: "hamyon", description: "👛 Balans va hamyon kodi" },
    { command: "liga", description: "🏆 Haftalik liga" },
    { command: "reyting", description: "💎 Eng boy foydalanuvchilar" },
    { command: "referral", description: "👥 Do'stlarni taklif qilish" },
  ]);
  if (MINI_APP_URL.startsWith("https://")) {
    await bot.api.setChatMenuButton({
      menu_button: { type: "web_app", text: "NexTrade", web_app: { url: MINI_APP_URL } },
    });
  }
}

bot.command("start", async (ctx) => {
  const telegramId = ctx.from?.id;
  const username = ctx.from?.username;
  if (!telegramId) return;

  const payload = ctx.match;
  let referrerTelegramId: number | undefined;
  if (typeof payload === "string" && payload.startsWith("ref_")) {
    const parsed = Number(payload.replace("ref_", ""));
    if (!isNaN(parsed)) referrerTelegramId = parsed;
  }

  const user = await getOrCreateUser(telegramId, username, referrerTelegramId);

  const keyboard = new InlineKeyboard().webApp("🚀 NexTrade'ni ochish", MINI_APP_URL);

  const bonusNote = referrerTelegramId
    ? `\n\n🎁 Siz do'stingiz taklifi bilan keldingiz! Birinchi savdoingizni qiling - ikkalangizga +${REFERRAL_REWARD} Nex Trade beriladi.`
    : "";

  await ctx.reply(
    `👋 NexTrade'ga xush kelibsiz!\n\n` +
      `💰 Balansingiz: ${Number(user.nex_trade_balance).toFixed(2)} Nex Trade\n\n` +
      `🪙 O'z tokeningizni yarating, boshqalarnikini sotib oling va foyda bilan soting.\n` +
      `🔥 Har kuni kiring - kunlik bonus seriyasi 100 Nex gacha o'sadi\n` +
      `🏆 Haftalik ligada top-10 ga kiring - mukofot oling${bonusNote}\n\n` +
      `Pastdagi tugma orqali ilovani oching 👇`,
    { reply_markup: keyboard }
  );
});

bot.command("referral", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const link = `https://t.me/${BOT_USERNAME}?start=ref_${telegramId}`;
  await ctx.reply(
    `👥 Do'stlaringizni taklif qiling!\n\n` +
      `Do'stingiz shu havola orqali kirib, birinchi savdosini qilganda ikkalangizga ham +${REFERRAL_REWARD} Nex Trade beriladi.\n\n` +
      `Sizning shaxsiy havolangiz:\n${link}`
  );
});

bot.command("hamyon", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getOrCreateUser(telegramId, ctx.from?.username);
  const keyboard = new InlineKeyboard().webApp("👛 Hamyonni ochish", MINI_APP_URL);
  await ctx.reply(
    `👛 Sizning hamyoningiz\n\n` +
      `💰 Balans: ${Number(user.nex_trade_balance).toFixed(2)} Nex Trade\n` +
      `🔑 Hamyon kodi: ${(user as any).wallet_code ?? "-"}\n\n` +
      `Do'stingiz sizga Nex Trade jo'natishi uchun shu kodni yuboring.`,
    { reply_markup: keyboard }
  );
});

bot.command("reyting", async (ctx) => {
  const top = await getUserLeaderboard(10);
  if (top.length === 0) {
    await ctx.reply("Hozircha reytingda hech kim yo'q.");
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = top.map((u, i) => {
    const medal = medals[i] ?? `${i + 1}.`;
    const name = u.username ? `@${u.username}` : `Foydalanuvchi #${u.id}`;
    return `${medal} ${name} — ${Number(u.nex_trade_balance).toFixed(2)} Nex Trade`;
  });

  await ctx.reply(`🏆 Eng boy foydalanuvchilar reytingi\n\n${lines.join("\n")}`);
});

bot.command("kunlik", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const user = await getOrCreateUser(telegramId, ctx.from?.username);

  try {
    const result = await claimStreakBonus(user.id);
    await ctx.reply(
      `🎁 Kunlik bonus: +${result.bonus} Nex Trade!\n` +
        `🔥 Seriya: ${result.streak} kun ketma-ket\n` +
        `💰 Balans: ${Number(result.newBalance).toFixed(2)} Nex Trade\n\n` +
        `Ertaga kelsangiz: +${result.nextReward} Nex. Seriyani uzmang!`
    );
  } catch (err: any) {
    await ctx.reply(`⏳ ${err.message}`);
  }
});

bot.command("liga", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = await getOrCreateUser(telegramId, ctx.from?.username);
  const league = await getLeague(user.id);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = league.top.map((u) => {
    const name = u.username ? `@${u.username}` : "Foydalanuvchi";
    return `${medals[u.rank - 1] ?? u.rank + "."} ${name} — +${u.pnl.toFixed(2)} Nex (🎁 ${u.prize})`;
  });
  const endsAt = new Date(league.endsAt);
  const hoursLeft = Math.max(0, Math.round((endsAt.getTime() - Date.now()) / 3_600_000));
  const keyboard = new InlineKeyboard().webApp("🏆 Ligani ochish", MINI_APP_URL);
  await ctx.reply(
    `🏆 Haftalik liga\n` +
      `⏳ Tugashiga ${Math.floor(hoursLeft / 24)} kun ${hoursLeft % 24} soat qoldi\n\n` +
      (lines.length ? lines.join("\n") : "Hali hech kim foyda bilan sotmadi - birinchi bo'ling!") +
      (league.me ? `\n\nSiz: ${league.me.rank}-o'rin (+${league.me.pnl.toFixed(2)} Nex)` : ""),
    { reply_markup: keyboard }
  );
});

// Muzlatilgan fond (savdo komissiyasining 0.15% qismi) holatini ko'rish - faqat admin
bot.command("muzlatilgan", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId || telegramId !== ADMIN_TELEGRAM_ID) {
    return;
  }

  const [balances, total] = await Promise.all([listFrozenBalances(), getTotalFrozen()]);

  if (balances.length === 0) {
    await ctx.reply("❄️ Hozircha muzlatilgan mablag' yo'q.");
    return;
  }

  const lines = balances.map(
    (b: any) => `• ${b.name} ($${b.symbol}, id:${b.token_id}) — ${Number(b.amount).toFixed(4)} Nex Trade`
  );

  await ctx.reply(
    `❄️ Muzlatilgan mablag'lar (bot/mini-app rivojlantirish fondi)\n\n${lines.join("\n")}\n\n` +
      `💰 Jami: ${total.toFixed(4)} Nex Trade\n\n` +
      `Yechib olish uchun: /yechish <token_id> <miqdor>`
  );
});

// Muzlatilgan fonddan mablag' yechib olish (o'z balansiga o'tadi) - faqat admin
bot.command("yechish", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId || telegramId !== ADMIN_TELEGRAM_ID) {
    return;
  }

  const args = (typeof ctx.match === "string" ? ctx.match : "").trim().split(/\s+/);
  const tokenId = Number(args[0]);
  const amount = Number(args[1]);

  if (!args[0] || !args[1] || !tokenId || !amount || amount <= 0) {
    await ctx.reply("Format: /yechish <token_id> <miqdor>\nMasalan: /yechish 3 1.5");
    return;
  }

  try {
    const result = await withdrawFrozen(telegramId, tokenId, amount);
    await ctx.reply(
      `✅ ${amount} Nex Trade muzlatilgan fonddan yechib olindi.\n` +
        `❄️ Ushbu tokenda qolgan muzlatilgan mablag': ${result.newFrozenBalance.toFixed(4)}\n` +
        `💰 Yangilangan balansingiz: ${Number(result.adminNewBalance).toFixed(4)} Nex Trade`
    );
  } catch (err: any) {
    await ctx.reply(`⚠️ ${err.message}`);
  }
});

/**
 * Umumiy xabar yuborish (bildirishnomalar uchun). Foydalanuvchi botni
 * bloklagan bo'lsa ham xato tashlamaydi.
 */
export async function sendTelegramMessage(telegramId: number, text: string): Promise<void> {
  if (!telegramId || telegramId <= 0) return;
  try {
    await bot.api.sendMessage(telegramId, text);
  } catch (err: any) {
    console.error("⚠️ Xabar yuborib bo'lmadi:", telegramId, err?.description ?? err?.message ?? err);
  }
}

bot.catch((err) => {
  console.error("Bot xatosi:", err);
});

/**
 * Token yaratuvchisiga, uning tokenidan savdo (sotib olish/sotish) bo'lganda
 * ulushiga qo'shilgan komissiya haqida Telegram orqali xabar yuboradi.
 *
 * tradeService.ts dagi buyToken/sellToken funksiyalari tranzaksiya muvaffaqiyatli
 * COMMIT bo'lgandan keyin shu funksiyani chaqiradi. Xabar yuborish xatoga uchrasa
 * (masalan, foydalanuvchi botni bloklagan bo'lsa) bu savdo natijasiga ta'sir
 * qilmasligi kerak - shuning uchun xato shu yerning o'zida ushlanadi.
 */
export async function notifyCreatorCommission(
  creatorTelegramId: number,
  tokenName: string,
  tokenSymbol: string,
  commissionAmount: number,
  tradeType: "buy" | "sell"
): Promise<void> {
  const actionLabel = tradeType === "buy" ? "sotib olindi" : "sotildi";
  try {
    await bot.api.sendMessage(
      creatorTelegramId,
      `💰 Sizga bonus qo'shildi!\n\n` +
        `${tokenName} ($${tokenSymbol}) tokeningizdan ${actionLabel}.\n` +
        `+${commissionAmount.toFixed(4)} Nex Trade "Bonuslar" jamg'armangizga qo'shildi.\n` +
        `Ilovadagi Profil > Bonuslar bo'limidan haftada 1 marta asosiy balansingizga o'tkazib olishingiz mumkin.`
    );
  } catch (err) {
    console.error("⚠️ Yaratuvchiga komissiya xabarini yuborib bo'lmadi:", err);
  }
}

bot.command("stats", async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId || telegramId !== ADMIN_TELEGRAM_ID) {
    return;
  }

  const stats = await getPlatformStats();
  await ctx.reply(
    `📊 Platforma statistikasi\n\n` +
      `👥 Foydalanuvchilar: ${stats.total_users}\n` +
      `🪙 Yaratilgan tokenlar: ${stats.total_tokens}\n` +
      `💰 Muomaladagi Nex Trade: ${Number(stats.total_nex_trade_circulating).toFixed(2)}\n` +
      `🔁 Jami savdolar: ${stats.total_trades}\n` +
      `📈 Savdo hajmi: ${Number(stats.total_volume).toFixed(2)} Nex Trade`
  );
});
