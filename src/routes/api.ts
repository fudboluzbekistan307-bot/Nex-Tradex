import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getUserHoldings, getReferralCount, getUserLeaderboard, claimDailyBonus } from "../services/userService";
import { getBalanceHistory } from "../services/balanceHistoryService";
import {
  createToken,
  getToken,
  listTopTokens,
  getFeaturedTokens,
  listLeaderboard,
  getTokenHistory,
  getTokenChartData,
  getTokensByOwner,
  searchTokens,
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
import { sendTelegramMessage } from "../bot/bot";

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

apiRouter.get("/tokens", ah(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 64) : "";
  const tokens = q ? await searchTokens(q) : await listTopTokens();
  res.json(tokens);
}));

apiRouter.get("/tokens/featured", ah(async (_req, res) => {
  res.json(await getFeaturedTokens());
}));

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

apiRouter.get("/tokens/:id/chart", ah(async (req, res) => {
  res.json(await getTokenChartData(Number(req.params.id)));
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

apiRouter.get("/nextrade/chart", ah(async (_req, res) => {
  res.json(await getNexTradePriceChart());
}));

apiRouter.get("/nextrade/topup-info", ah(async (_req, res) => {
  res.json(await getTopupWithdrawInfo());
}));

// ================================================================
// Shu nuqtadan pastdagi HAMMA route'lar Telegram autentifikatsiyasini talab qiladi
// ================================================================
apiRouter.use(requireAuth);

// Foydalanuvchini ro'yxatdan o'tkazish / olish. Referal endi imzolangan
// initData'dagi start_param'dan olinadi (requireAuth ichida).
apiRouter.post("/user/init", ah(async (req, res) => {
  res.json(req.user);
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

apiRouter.post("/user/:userId/daily-bonus", ahUser(async (req, res) => {
  res.json(await claimDailyBonus(uid(req)));
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
    image_url: z
      .string()
      .trim()
      .url()
      .max(1000)
      .refine((u) => /^https?:\/\//i.test(u), "Rasm havolasi http(s):// bilan boshlanishi kerak")
      .optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message;
    return res.status(400).json({ error: msg && !msg.startsWith("Expected") && !msg.startsWith("Invalid") ? msg : "Hamma maydonlarni to'g'ri to'ldiring" });
  }

  const token = await createToken(
    uid(req),
    parsed.data.name,
    parsed.data.symbol,
    parsed.data.max_supply,
    parsed.data.image_url
  );
  res.json(token);
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
