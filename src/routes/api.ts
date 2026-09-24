import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getUserHoldings, getReferralCount, getUserLeaderboard } from "../services/userService";
import { getBalanceHistory } from "../services/balanceHistoryService";
import {
  createToken,
  getToken,
  listLeaderboard,
  getTokenHistory,
  getTokenChartData,
  getTokensByOwner,
  boostToken,
  getTradeQuote,
  upgradeTokenToPro,
  getProBadgeCost,
} from "../services/tokenService";
import { buyToken, sellToken } from "../services/tradeService";
import { getFavoriteTokens, getFavoriteTokenIds, toggleFavorite } from "../services/favoriteService";
import { getUserAlerts, subscribeAlert, unsubscribeAlert } from "../services/alertService";
import {
  listFrozenBalances,
  getTotalFrozen,
  withdrawFrozen,
  withdrawAllFrozen,
  getAdminWithdrawStatus,
} from "../services/frozenService";
import { getNexTradePrice, getNexTradePriceChart } from "../services/nexTradePriceService";
import { getWalletInfo, sendTransfer, getTransferHistory } from "../services/walletService";
import { getBonusInfo, claimBonus } from "../services/bonusService";
import { getTopupWithdrawInfo, topupNexTradex, withdrawNexTradex } from "../services/nexTopupService";
import { floor4 } from "../services/pricingService";
import { requireAuth, requireSelf, requireAdmin } from "../middleware/auth";
import { writeLimiter } from "../middleware/rateLimit";
import { getSeason, getAdminStats } from "../services/retentionService";
import { getGroupLeague, getClanLeague, getMyClan, createClan, joinClan, leaveClan, CLAN_CREATE_FEE, CLAN_MAX_MEMBERS } from "../services/groupService";
import { TOKEN_CREATE_FEE, IPO_DELAY_MINUTES, listUpcomingTokens } from "../services/tokenService";
import { bot } from "../bot/bot";
import { sendTelegramMessage } from "../bot/bot";
import { listTokensWithStats, getTokenStats, getTokenChartRange, getNexTradeChartRange, MarketSort } from "../services/marketService";
import { getStreakStatus, claimStreakBonus, getMissions, claimMission, getLeague, REFERRAL_REWARD } from "../services/engagementService";
import { announceNewToken } from "../services/announceService";
import { containsBadWords, deleteComment } from "../services/moderationService";
import {
  getWheelStatus, spinWheel, getAchievements, listComments, addComment,
  createLimitOrder, listLimitOrders, cancelLimitOrder,
  starsPrices, validateStarsPurchase, buildPayload, StarsKind,
} from "../services/featuresService";
import { isAdmin } from "../middleware/auth";

export const apiRouter = Router();

/**
 * XAVFSIZLIK: foydalanuvchi kimligi endi FAQAT Telegram imzolangan initData
 * orqali aniqlanadi (req.user). Frontend body'da user_id / owner_id /
 * from_user_id yuborsa ham, ular E'TIBORGA OLINMAYDI.
 */

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<any>;
function ah(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/** Biznes-logika xatolarini (throw new Error("...")) 400 sifatida qaytaradi. */
function ahUser(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch((err: any) => {
      // Postgres texnik xatolari (kod bilan) - umumiy xato ishlovchiga
      if (err?.code && err.code !== "23505") return next(err);
      if (err?.code === "23505") {
        return res.status(400).json({ error: "Bu belgi (symbol) allaqachon band. Boshqasini tanlang" });
      }
      res.status(400).json({ error: err?.message ?? "Xatolik yuz berdi" });
    });
  };
}

const posAmount = z.number().finite().positive().max(1e12);
const id = z.number().int().positive();

function uid(req: Request): number {
  return req.user!.id;
}

// ================================================================
// OCHIQ (autentifikatsiyasiz) - faqat umumiy bozor ma'lumotlari
// ================================================================

apiRouter.get("/ping", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

apiRouter.get("/pro-badge-cost", (_req, res) => {
  res.json({ cost: getProBadgeCost() });
});

// Bozor: ?sort=trend|new|volume|price, ?q=qidiruv. Har bir token bilan
// change_24h (%) va volume_24h qaytadi.
apiRouter.get("/tokens", ah(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 64) : "";
  const sort = (typeof req.query.sort === "string" ? req.query.sort : "trend") as MarketSort;
  const tokens = q
    ? await listTokensWithStats({ search: q, sort })
    : await listTokensWithStats({ featured: false, sort });
  res.json(tokens);
}));

apiRouter.get("/tokens/upcoming", ah(async (_req, res) => {
  res.json(await listUpcomingTokens());
}));

apiRouter.get("/season", ah(async (_req, res) => {
  res.json(await getSeason());
}));

apiRouter.get("/groups/league", ah(async (_req, res) => {
  res.json(await getGroupLeague(10));
}));

apiRouter.get("/clans/top", ah(async (_req, res) => {
  res.json({ clans: await getClanLeague(10), fee: CLAN_CREATE_FEE, maxMembers: CLAN_MAX_MEMBERS });
}));

apiRouter.get("/token-create-info", (_req, res) => {
  res.json({ fee: TOKEN_CREATE_FEE, ipoDelayMinutes: IPO_DELAY_MINUTES });
});

apiRouter.get("/tokens/featured", ah(async (_req, res) => {
  res.json(await listTokensWithStats({ featured: true, sort: "price" }));
}));

apiRouter.get("/tokens/:id/comments", ah(async (req, res) => {
  res.json(await listComments(Number(req.params.id)));
}));

apiRouter.get("/stars/prices", (_req, res) => {
  res.json(starsPrices());
});

apiRouter.get("/referral-info", (_req, res) => {
  res.json({ reward: REFERRAL_REWARD });
});

apiRouter.get("/tokens/:id", ah(async (req, res) => {
  const token = await getToken(Number(req.params.id));
  if (!token) return res.status(404).json({ error: "Token topilmadi" });
  res.json(token);
}));

apiRouter.get("/tokens/:id/quote", ahUser(async (req, res) => {
  const side = req.query.side === "sell" ? "sell" : "buy";
  const amount = Number(req.query.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Miqdorni kiriting" });
  res.json(await getTradeQuote(Number(req.params.id), side, amount));
}));

apiRouter.get("/tokens/:id/history", ah(async (req, res) => {
  res.json(await getTokenHistory(Number(req.params.id)));
}));

// Grafik: ?range=1h|24h|7d (range bo'lmasa - eski usul, oxirgi 100 nuqta)
apiRouter.get("/tokens/:id/chart", ah(async (req, res) => {
  const range = typeof req.query.range === "string" ? req.query.range : "";
  res.json(range ? await getTokenChartRange(Number(req.params.id), range) : await getTokenChartData(Number(req.params.id)));
}));

// Token sahifasi statistikasi: 24s o'zgarish, hajm, egalar, top-5 ega
apiRouter.get("/tokens/:id/stats", ahUser(async (req, res) => {
  res.json(await getTokenStats(Number(req.params.id)));
}));

apiRouter.get("/leaderboard", ah(async (_req, res) => {
  res.json(await listLeaderboard());
}));

apiRouter.get("/leaderboard/users", ah(async (_req, res) => {
  res.json(await getUserLeaderboard());
}));

apiRouter.get("/nextrade/price", ah(async (_req, res) => {
  res.json(await getNexTradePrice());
}));

apiRouter.get("/nextrade/chart", ah(async (req, res) => {
  const range = typeof req.query.range === "string" ? req.query.range : "";
  res.json(range ? await getNexTradeChartRange(range) : await getNexTradePriceChart());
}));

apiRouter.get("/nextrade/topup-info", ah(async (_req, res) => {
  res.json(await getTopupWithdrawInfo());
}));

// ================================================================
// Shu nuqtadan pastdagi HAMMA route'lar Telegram autentifikatsiyasini talab qiladi
// ================================================================
apiRouter.use(requireAuth);
// Pul o'zgartiradigan so'rovlar uchun foydalanuvchi bo'yicha cheklov
apiRouter.use(writeLimiter);

// Foydalanuvchini ro'yxatdan o'tkazish / olish. Referal endi imzolangan
// initData'dagi start_param'dan olinadi (requireAuth ichida).
apiRouter.post("/user/init", ah(async (req, res) => {
  res.json({ ...req.user, is_admin: isAdmin(req.user) });
}));

// ---------- Faqat o'z ma'lumotlari (/user/:userId/...) ----------
apiRouter.use("/user/:userId", requireSelf);

apiRouter.get("/user/:userId/referrals", ah(async (req, res) => {
  res.json({ count: await getReferralCount(uid(req)) });
}));

apiRouter.get("/user/:userId/created-tokens", ah(async (req, res) => {
  res.json(await getTokensByOwner(uid(req)));
}));

apiRouter.get("/user/:userId/holdings", ah(async (req, res) => {
  res.json(await getUserHoldings(uid(req)));
}));

// Kunlik bonus endi SERIYA (streak) bilan: ketma-ket kunlar uchun o'sib boradi
apiRouter.get("/user/:userId/streak", ahUser(async (req, res) => {
  res.json(await getStreakStatus(uid(req)));
}));

apiRouter.post("/user/:userId/daily-bonus", ahUser(async (req, res) => {
  res.json(await claimStreakBonus(uid(req)));
}));

// Omad g'ildiragi
apiRouter.get("/user/:userId/wheel", ahUser(async (req, res) => {
  res.json(await getWheelStatus(uid(req)));
}));

apiRouter.post("/user/:userId/wheel/spin", ahUser(async (req, res) => {
  res.json(await spinWheel(uid(req)));
}));

// Daraja va nishonlar
apiRouter.get("/user/:userId/achievements", ahUser(async (req, res) => {
  res.json(await getAchievements(uid(req)));
}));

// Limit buyurtmalar (?token_id= bilan faqat shu token)
apiRouter.get("/user/:userId/orders", ahUser(async (req, res) => {
  const tokenId = Number(req.query.token_id) || undefined;
  res.json(await listLimitOrders(uid(req), tokenId));
}));

// Til (bot xabarlari uchun)
apiRouter.post("/user/:userId/language", ahUser(async (req, res) => {
  const lang = req.body?.lang === "ru" ? "ru" : "uz";
  const { pool } = await import("../db/pool");
  await pool.query("UPDATE users SET language = $1 WHERE id = $2", [lang, uid(req)]);
  res.json({ lang });
}));

// Vazifalar
apiRouter.get("/user/:userId/missions", ahUser(async (req, res) => {
  res.json(await getMissions(uid(req)));
}));

apiRouter.post("/user/:userId/missions/:missionId/claim", ahUser(async (req, res) => {
  res.json(await claimMission(uid(req), String(req.params.missionId)));
}));

apiRouter.get("/user/:userId/balance-history", ah(async (req, res) => {
  res.json(await getBalanceHistory(uid(req)));
}));

apiRouter.get("/user/:userId/wallet", ahUser(async (req, res) => {
  res.json(await getWalletInfo(uid(req)));
}));

apiRouter.get("/user/:userId/wallet/history", ah(async (req, res) => {
  res.json(await getTransferHistory(uid(req)));
}));

apiRouter.get("/user/:userId/favorites", ah(async (req, res) => {
  res.json(await getFavoriteTokens(uid(req)));
}));

apiRouter.get("/user/:userId/favorites/ids", ah(async (req, res) => {
  res.json(await getFavoriteTokenIds(uid(req)));
}));

apiRouter.get("/user/:userId/alerts", ah(async (req, res) => {
  res.json(await getUserAlerts(uid(req)));
}));

// YANGI (frontendda bor edi, backendda yo'q edi): yaratuvchi bonuslari
apiRouter.get("/user/:userId/bonus", ah(async (req, res) => {
  res.json(await getBonusInfo(uid(req)));
}));

apiRouter.post("/user/:userId/bonus/claim", ahUser(async (req, res) => {
  res.json(await claimBonus(uid(req)));
}));

// ---------- Hamyon ----------
apiRouter.post("/wallet/transfer", ahUser(async (req, res) => {
  const parsed = z.object({
    to_wallet_code: z.string().trim().min(4).max(16),
    amount: posAmount,
    note: z.string().max(140).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Ma'lumotlarni to'g'ri kiriting" });

  const result = await sendTransfer(uid(req), parsed.data.to_wallet_code, parsed.data.amount, parsed.data.note);

  // Qabul qiluvchiga botdan xabar (savdoni kutdirmaymiz)
  sendTelegramMessage(
    result.receiverTelegramId,
    `💸 Hamyoningizga ${result.amount} Nex Trade keldi!\n` +
      `Kimdan: ${result.senderWalletCode}` +
      (parsed.data.note ? `\nIzoh: ${parsed.data.note}` : "")
  );

  res.json({ newBalance: result.newBalance, receiverWalletCode: result.receiverWalletCode });
}));

// ---------- Tokenlar ----------
apiRouter.post("/tokens", ahUser(async (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(64).refine((s) => !/[<>]/.test(s), "Nomda < > belgilari bo'lmasin"),
    symbol: z.string().trim().regex(/^[A-Za-z0-9]{2,10}$/, "Belgi 2-10 ta lotin harf/raqam bo'lishi kerak"),
    max_supply: z.number().int().min(10).max(10000),
    ipo: z.boolean().optional(),
    image_url: z
      .string()
      .trim()
      .url()
      .max(1000)
      .refine((u) => /^https?:\/\//i.test(u), "Rasm havolasi http(s):// bilan boshlanishi kerak")
      .optional(),
  }).safeParse(req.body);
  if (parsed.success && (containsBadWords(parsed.data.name) || containsBadWords(parsed.data.symbol))) {
    return res.status(400).json({ error: "Token nomida nomaqbul so'zlar bor. Boshqa nom tanlang" });
  }
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message;
    return res.status(400).json({ error: msg && !msg.startsWith("Expected") && !msg.startsWith("Invalid") ? msg : "Hamma maydonlarni to'g'ri to'ldiring" });
  }

  const token = await createToken(
    uid(req),
    parsed.data.name,
    parsed.data.symbol,
    parsed.data.max_supply,
    parsed.data.image_url,
    parsed.data.ipo ?? false
  );
  // IPO bo'lsa - yaratuvchi avtomatik "ochilish"dan xabardor bo'ladi
  if (parsed.data.ipo) await subscribeAlert(uid(req), token.id, 5).catch(() => {});
  res.json(token);
  // Kanalga e'lon (ANNOUNCE_CHAT_ID sozlangan bo'lsa) - javobni kutdirmaymiz
  announceNewToken(token, req.user!.username).catch(() => {});
}));

apiRouter.post("/tokens/:id/boost", ahUser(async (req, res) => {
  const parsed = z.object({ amount: posAmount }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Miqdorni to'g'ri kiriting" });
  const amount = floor4(parsed.data.amount);
  if (amount <= 0) return res.status(400).json({ error: "Miqdorni to'g'ri kiriting" });
  res.json(await boostToken(Number(req.params.id), uid(req), amount));
}));

apiRouter.post("/tokens/:id/pro-upgrade", ahUser(async (req, res) => {
  res.json(await upgradeTokenToPro(Number(req.params.id), uid(req)));
}));

// ---------- Savdo ----------
const tradeSchema = z.object({ token_id: id, amount: posAmount });

apiRouter.post("/trade/buy", ahUser(async (req, res) => {
  const parsed = tradeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Miqdorni to'g'ri kiriting" });
  res.json(await buyToken(uid(req), parsed.data.token_id, parsed.data.amount));
}));

apiRouter.post("/trade/sell", ahUser(async (req, res) => {
  const parsed = tradeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Miqdorni to'g'ri kiriting" });
  res.json(await sellToken(uid(req), parsed.data.token_id, parsed.data.amount));
}));

// ---------- Sevimlilar va bildirishnomalar ----------
apiRouter.post("/favorites/toggle", ahUser(async (req, res) => {
  const parsed = z.object({ token_id: id }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Ma'lumotlar noto'g'ri kiritildi" });
  res.json(await toggleFavorite(uid(req), parsed.data.token_id));
}));

apiRouter.post("/alerts", ahUser(async (req, res) => {
  const parsed = z.object({
    token_id: id,
    threshold_pct: z.number().min(1).max(100).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Ma'lumotlar noto'g'ri kiritildi" });
  res.json(await subscribeAlert(uid(req), parsed.data.token_id, parsed.data.threshold_pct ?? 5));
}));

apiRouter.delete("/alerts", ahUser(async (req, res) => {
  const parsed = z.object({ token_id: id }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Ma'lumotlar noto'g'ri kiritildi" });
  await unsubscribeAlert(uid(req), parsed.data.token_id);
  res.json({ ok: true });
}));

// ---------- Izohlar ----------
apiRouter.post("/tokens/:id/comments", ahUser(async (req, res) => {
  const parsed = z.object({ text: z.string().min(1).max(280) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Izoh 1-280 belgidan iborat bo'lsin" });
  res.json(await addComment(uid(req), Number(req.params.id), parsed.data.text));
}));

// ---------- Limit buyurtmalar ----------
apiRouter.post("/orders", ahUser(async (req, res) => {
  const parsed = z.object({
    token_id: id,
    side: z.enum(["buy", "sell"]),
    amount: posAmount,
    trigger_price: z.number().finite().positive(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Ma'lumotlarni to'g'ri kiriting" });
  const d = parsed.data;
  res.json(await createLimitOrder(uid(req), d.token_id, d.side, d.amount, d.trigger_price));
}));

apiRouter.delete("/orders/:orderId", ahUser(async (req, res) => {
  await cancelLimitOrder(uid(req), Number(req.params.orderId));
  res.json({ ok: true });
}));

// ---------- Telegram Stars ----------
// Mini App ichida to'lov oynasini ochish uchun invoice havolasi yaratadi
apiRouter.post("/tokens/:id/stars-invoice", ahUser(async (req, res) => {
  const kind: StarsKind = req.body?.kind === "promo" ? "promo" : "pro";
  const tokenId = Number(req.params.id);
  const t = await validateStarsPurchase(kind, tokenId, uid(req));
  const prices = starsPrices();
  const amount = kind === "pro" ? prices.pro : prices.promo;
  const title = kind === "pro" ? `✅ PRO nishon: ${t.symbol}` : `📣 Reklama 24 soat: ${t.symbol}`;
  const description = kind === "pro"
    ? `${t.name} tokeni bozorda "PRO" belgisi bilan ajralib turadi.`
    : `${t.name} tokeni 24 soat davomida bozor ro'yxatining eng tepasida turadi.`;
  const link = await bot.api.createInvoiceLink(title, description, buildPayload(kind, tokenId, uid(req)), "", "XTR", [
    { label: title, amount },
  ]);
  res.json({ link, stars: amount });
}));

// ---------- Klanlar ----------
apiRouter.get("/user/:userId/clan", ah(async (req, res) => {
  res.json(await getMyClan(uid(req)));
}));

apiRouter.post("/clans", ahUser(async (req, res) => {
  const parsed = z.object({ name: z.string().min(1).max(40), tag: z.string().min(1).max(8) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Nom va belgini kiriting" });
  res.json(await createClan(uid(req), parsed.data.name, parsed.data.tag));
}));

apiRouter.post("/clans/join", ahUser(async (req, res) => {
  const parsed = z.object({ tag: z.string().min(1).max(10) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Klan belgisini kiriting" });
  res.json(await joinClan(uid(req), parsed.data.tag));
}));

apiRouter.post("/clans/leave", ahUser(async (req, res) => {
  await leaveClan(uid(req));
  res.json({ ok: true });
}));

// ---------- Haftalik liga ----------
apiRouter.get("/league", ah(async (req, res) => {
  res.json(await getLeague(uid(req)));
}));

// ---------- YANGI: Nex Tradex to'ldirish / chiqarish ----------
apiRouter.post("/nextrade/topup", ahUser(async (req, res) => {
  const parsed = z.object({ amount: posAmount }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Miqdorni to'g'ri kiriting" });
  res.json(await topupNexTradex(uid(req), floor4(parsed.data.amount)));
}));

apiRouter.post("/nextrade/withdraw", ahUser(async (req, res) => {
  const parsed = z.object({ amount: posAmount }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Miqdorni to'g'ri kiriting" });
  res.json(await withdrawNexTradex(uid(req), floor4(parsed.data.amount)));
}));

// ================================================================
// ADMIN (faqat ADMIN_TELEGRAM_ID) - admin_telegram_id endi body'dan emas,
// imzolangan initData'dan olinadi
// ================================================================
apiRouter.use("/admin", requireAdmin);

apiRouter.get("/admin/stats", ah(async (_req, res) => {
  res.json(await getAdminStats());
}));

apiRouter.delete("/admin/comments/:commentId", ahUser(async (req, res) => {
  await deleteComment(Number(req.params.commentId));
  res.json({ ok: true });
}));

apiRouter.get("/admin/frozen", ah(async (_req, res) => {
  const [balances, total] = await Promise.all([listFrozenBalances(), getTotalFrozen()]);
  res.json({ total, balances });
}));

apiRouter.get("/admin/frozen/withdraw-status", ahUser(async (req, res) => {
  res.json(await getAdminWithdrawStatus(Number(req.user!.telegram_id)));
}));

apiRouter.post("/admin/frozen/withdraw-all", ahUser(async (req, res) => {
  res.json(await withdrawAllFrozen(Number(req.user!.telegram_id)));
}));

apiRouter.post("/admin/frozen/withdraw", ahUser(async (req, res) => {
  const parsed = z.object({ token_id: id, amount: posAmount }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Ma'lumotlar noto'g'ri kiritildi" });
  res.json(await withdrawFrozen(Number(req.user!.telegram_id), parsed.data.token_id, parsed.data.amount));
}));
