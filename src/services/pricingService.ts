/**
 * Bonding Curve narx mexanizmi.
 *
 * Narx formulasi:
 *   narx(s) = base_price * (1 + s / max_supply) ^ k
 *
 * Token qancha ko'p sotib olinsa (circulating_supply oshsa), narx ko'tariladi.
 * Token qancha ko'p sotilsa (circulating_supply kamaysa), narx tushadi.
 * Bundan tashqari narxga avtomatik tebranish ham ta'sir qiladi
 * (priceFluctuationService.ts) - shuning uchun "drift" koeffitsienti ishlatiladi.
 *
 * MUHIM: MIN_PRICE/MAX_PRICE faqat token YARATILGANDA tanlanadigan boshlang'ich
 * narx (base_price) uchun. Keyin narxga yuqori chegara QO'YILMAYDI.
 */

const MIN_PRICE = 0.0001;
const MAX_PRICE = 0.01;

// Savdo/tebranish paytida narx hech qachon bundan pastga tushmaydi.
export const ABSOLUTE_MIN_PRICE = MIN_PRICE;

// Token miqdori bazada NUMERIC(20,4) - ya'ni 4 xonagacha aniqlik.
export const AMOUNT_DECIMALS = 4;
export const MIN_TRADE_AMOUNT = 0.0001;

/** Miqdorni 4 xonagacha PASTGA yaxlitlaydi (foydalanuvchi oladigan token/pul uchun). */
export function floor4(n: number): number {
  return Math.floor(n * 10_000 + 1e-9) / 10_000;
}

/** Miqdorni 4 xonagacha YUQORIGA yaxlitlaydi (foydalanuvchidan yechiladigan pul uchun). */
export function ceil4(n: number): number {
  return Math.ceil(n * 10_000 - 1e-9) / 10_000;
}

export function calculatePrice(
  basePrice: number,
  circulatingSupply: number,
  maxSupply: number,
  k: number
): number {
  const ratio = circulatingSupply / maxSupply;
  const rawPrice = basePrice * Math.pow(1 + ratio, k);
  return Math.max(rawPrice, ABSOLUTE_MIN_PRICE);
}

/**
 * Egri chiziq ostidagi yuza (aniq integral) s0 dan s1 gacha:
 *   ∫ base * (1 + s/M)^k ds = base * M / (k+1) * [(1 + s/M)^(k+1)]
 *
 * XATOLIK TUZATILDI: avvalgi versiya 10 qadamli "chap to'rtburchak" usulida
 * taxminiy hisoblardi. Natijada sotib olishda narx ARZONROQ, sotishda esa
 * QIMMATROQ chiqardi - katta miqdorda sotib olib darhol sotgan odam
 * to'lagandan ko'proq pul qaytarib olardi (komissiyadan keyin ham).
 * Aniq integral bilan "sotib olib - darhol sotish" doim 0 (minus komissiya).
 */
function curveArea(basePrice: number, s0: number, s1: number, maxSupply: number, k: number): number {
  const F = (s: number) => Math.pow(1 + s / maxSupply, k + 1);
  return (basePrice * maxSupply) / (k + 1) * (F(s1) - F(s0));
}

/**
 * Ekrandagi (tebranish bilan o'zgargan) narx va sof formula narxi orasidagi
 * nisbat. Savdo shu koeffitsient bilan ko'paytiriladi - natijada savdo doim
 * foydalanuvchi ekranda ko'rgan narxdan boshlanadi.
 */
function getDrift(basePrice: number, supply: number, maxSupply: number, k: number, displayed?: number) {
  const curvePrice = calculatePrice(basePrice, supply, maxSupply, k);
  return displayed && curvePrice > 0 ? displayed / curvePrice : 1;
}

export function calculateBuyCost(
  basePrice: number,
  currentSupply: number,
  maxSupply: number,
  k: number,
  buyAmount: number,
  displayedCurrentPrice?: number
): { totalCost: number; newSupply: number; newPrice: number } {
  const drift = getDrift(basePrice, currentSupply, maxSupply, k, displayedCurrentPrice);
  const newSupply = currentSupply + buyAmount;
  const totalCost = curveArea(basePrice, currentSupply, newSupply, maxSupply, k) * drift;
  const newPrice = Math.max(calculatePrice(basePrice, newSupply, maxSupply, k) * drift, ABSOLUTE_MIN_PRICE);
  return { totalCost, newSupply, newPrice };
}

export function calculateSellReturn(
  basePrice: number,
  currentSupply: number,
  maxSupply: number,
  k: number,
  sellAmount: number,
  displayedCurrentPrice?: number
): { totalReturn: number; newSupply: number; newPrice: number } {
  const drift = getDrift(basePrice, currentSupply, maxSupply, k, displayedCurrentPrice);
  const newSupply = Math.max(currentSupply - sellAmount, 0);
  const totalReturn = curveArea(basePrice, newSupply, currentSupply, maxSupply, k) * drift;
  const newPrice = Math.max(calculatePrice(basePrice, newSupply, maxSupply, k) * drift, ABSOLUTE_MIN_PRICE);
  return { totalReturn, newSupply, newPrice };
}

/**
 * Token yaratilganda boshlang'ich narxni tanlaydi (0.0001 - 0.01 oralig'ida).
 * Nom asosida deterministik "omad" hosil qilinadi.
 */
export function generateInitialPrice(symbol: string): number {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) {
    hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
  }
  const fraction = (hash % 10000) / 10000;
  return MIN_PRICE + fraction * (MAX_PRICE - MIN_PRICE);
}
