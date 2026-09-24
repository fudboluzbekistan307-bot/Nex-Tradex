-- NexTrade platformasi uchun baza sxemasi

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT UNIQUE NOT NULL,
    username VARCHAR(255),
    nex_trade_balance NUMERIC(20, 4) NOT NULL DEFAULT 100.0000,  -- boshlang'ich 100 ta Nex Trade
    referred_by INTEGER REFERENCES users(id),  -- kim taklif qilgani (referal)
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tokens (
    id SERIAL PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    name VARCHAR(64) NOT NULL,
    symbol VARCHAR(16) NOT NULL UNIQUE,
    max_supply NUMERIC(20, 4) NOT NULL CHECK (max_supply > 0 AND max_supply <= 10000),
    circulating_supply NUMERIC(20, 4) NOT NULL DEFAULT 0,
    base_price NUMERIC(10, 8) NOT NULL CHECK (base_price >= 0.0001 AND base_price <= 0.01),
    current_price NUMERIC(10, 8) NOT NULL,
    curve_k NUMERIC(5, 2) NOT NULL DEFAULT 1.5,  -- bonding curve tezligi
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS holdings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    amount NUMERIC(20, 4) NOT NULL DEFAULT 0 CHECK (amount >= 0),
    UNIQUE(user_id, token_id)
);

CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    type VARCHAR(4) NOT NULL CHECK (type IN ('buy', 'sell')),
    amount NUMERIC(20, 4) NOT NULL CHECK (amount > 0),
    price NUMERIC(10, 8) NOT NULL,
    total_cost NUMERIC(20, 4) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Savdodan mustaqil, har 10 soniyada qo'shiladigan avtomatik narx tebranishlari.
-- Grafikda savdo tarixi bilan birga ko'rsatiladi.
CREATE TABLE IF NOT EXISTS price_ticks (
    id SERIAL PRIMARY KEY,
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    price NUMERIC(20, 8) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_holdings_token ON holdings(token_id);
CREATE INDEX IF NOT EXISTS idx_transactions_token ON transactions(token_id);
CREATE INDEX IF NOT EXISTS idx_tokens_owner ON tokens(owner_id);
CREATE INDEX IF NOT EXISTS idx_price_ticks_token ON price_ticks(token_id);

-- Narxga endi yuqori chegara qo'yilmagani uchun ustunlar kengligini oshiramiz
-- (base_price hamon 0.0001-0.01 oralig'ida cheklangan, faqat current_price
-- va tranzaksiya narxi endi erkin o'sishi mumkin).
ALTER TABLE tokens ALTER COLUMN current_price TYPE NUMERIC(20, 8);
ALTER TABLE transactions ALTER COLUMN price TYPE NUMERIC(20, 8);

-- Kunlik bonus oxirgi marta qachon olinganini kuzatish uchun
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily_bonus_at TIMESTAMP;

-- Portfelda foyda/zarar foizini hisoblash uchun o'rtacha xarid narxi
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS avg_cost NUMERIC(20, 8) NOT NULL DEFAULT 0;

-- Sevimli tokenlar
CREATE TABLE IF NOT EXISTS favorites (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, token_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);

-- Foydalanuvchi tanlagan tokenlar uchun narx bildirishnomalari
CREATE TABLE IF NOT EXISTS token_alerts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    threshold_pct NUMERIC(5, 2) NOT NULL DEFAULT 5,
    last_notified_price NUMERIC(20, 8),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, token_id)
);
CREATE INDEX IF NOT EXISTS idx_token_alerts_token ON token_alerts(token_id);

-- Savdo komissiyasi: har bir sotib olish/sotishda 0.25% komissiya olinadi.
-- total_cost ustuni bonding curve bo'yicha xarajat/tushumni saqlaydi (o'zgarmaydi),
-- commission esa shundan ALOHIDA ushlab qolingan 0.25% miqdorni saqlaydi
-- (buni 0.1% qismi token yaratuvchisiga, 0.15% qismi muzlatilgan fondga boradi).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS commission NUMERIC(20, 8) NOT NULL DEFAULT 0;

-- Har bir savdo komissiyasining 0.15% qismi shu yerga - tokenga bog'liq
-- "muzlatilgan mablag'" fondiga - yig'ilib boriladi. Bu fond faqat ADMIN
-- tomonidan botni/mini-appni rivojlantirish maqsadida yechib olinishi mumkin
-- (qarang: src/services/frozenService.ts).
CREATE TABLE IF NOT EXISTS frozen_balances (
    token_id INTEGER PRIMARY KEY REFERENCES tokens(id),
    amount NUMERIC(20, 8) NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Admin tomonidan muzlatilgan fonddan yechib olingan mablag'lar tarixi
-- (audit va shaffoflik uchun saqlanadi).
CREATE TABLE IF NOT EXISTS frozen_withdrawals (
    id SERIAL PRIMARY KEY,
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    amount NUMERIC(20, 8) NOT NULL,
    admin_user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_frozen_withdrawals_token ON frozen_withdrawals(token_id);

-- Nex Trade (asosiy valyuta) ning real dunyo (UZS) qiymati. Bitta qatorli
-- jadval - hozirgi narxni saqlaydi. Boshlang'ich qiymat 0.9957 UZS.
CREATE TABLE IF NOT EXISTS nex_trade_price (
    id INTEGER PRIMARY KEY DEFAULT 1,
    price NUMERIC(20, 8) NOT NULL DEFAULT 0.9957,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CHECK (id = 1)
);
INSERT INTO nex_trade_price (id, price)
VALUES (1, 0.9957)
ON CONFLICT (id) DO NOTHING;

-- Nex Trade narxining tarixi - grafik chizish uchun (tokenlardagi price_ticks
-- kabi, lekin bu safar butun platformaning asosiy valyutasi uchun).
CREATE TABLE IF NOT EXISTS nex_trade_price_ticks (
    id SERIAL PRIMARY KEY,
    price NUMERIC(20, 8) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nex_trade_price_ticks_time ON nex_trade_price_ticks(created_at);

-- Foydalanuvchi Nex Trade balansi har o'zgarganda shu yerga "surat" (snapshot)
-- sifatida yoziladi - Portfolio grafigini chizish uchun ishlatiladi.
CREATE TABLE IF NOT EXISTS balance_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    balance NUMERIC(20, 4) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_balance_history_user_time ON balance_history(user_id, created_at);

-- Token uchun rasm (logotip) - foydalanuvchi token yaratganda URL kiritadi.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Token egasi o'z Nex Trade'ini tokeniga "kiritib" (qaytarilmas tarzda)
-- narxini doimiy oshirishi mumkin - shu tarix shu yerda saqlanadi.
CREATE TABLE IF NOT EXISTS token_boosts (
    id SERIAL PRIMARY KEY,
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount NUMERIC(20, 4) NOT NULL,
    old_base_price NUMERIC(20, 8) NOT NULL,
    new_base_price NUMERIC(20, 8) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_boosts_token ON token_boosts(token_id);

-- MUHIM TUZATISH: base_price ustuni hali ham eski CHECK (<= 0.01) chegarasini
-- va tor NUMERIC(10,8) turini saqlab turgan edi. Shu sabab "kuchaytirish" (boost)
-- funksiyasi bazaga yozishda har doim xato berayotgan edi, chunki base_price
-- boost natijasida 0.01 dan oshib ketishi tabiiy holat. Endi bu chegara olib
-- tashlanadi va ustun current_price kabi keng turga o'tkaziladi.
ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_base_price_check;
ALTER TABLE tokens ALTER COLUMN base_price TYPE NUMERIC(20, 8);

-- PRO NISHON: bu real pulga aloqasi yo'q, faqat ichki Nex Trade sarflab
-- tokenni "tasdiqlangan/PRO" deb belgilash - reklama/nishon maqsadida.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS is_pro BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS pro_since TIMESTAMP;

-- GIGANT TOKENLAR: platformaning o'zi tomonidan yaratilgan, yuqori boshlang'ich
-- narxli (12,000-67,000 UZS) tokenlar - bozorda alohida ajratib ko'rsatiladi.
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT false;

-- Bu tokenlarning "egasi" - platformaning tizim hisobi (haqiqiy Telegram
-- foydalanuvchisi emas, shuning uchun manfiy telegram_id ishlatiladi -
-- haqiqiy Telegram ID'lar doim musbat bo'ladi, shu bilan to'qnashuv bo'lmaydi).
INSERT INTO users (telegram_id, username, nex_trade_balance)
VALUES (-1, 'NexTrade Platform', 0)
ON CONFLICT (telegram_id) DO NOTHING;

INSERT INTO tokens (owner_id, name, symbol, max_supply, circulating_supply, base_price, current_price, curve_k, is_featured)
SELECT u.id, 'NexGold', 'NXG', 600, 0, 45000, 45000, 1.5, true
FROM users u WHERE u.telegram_id = -1
ON CONFLICT (symbol) DO NOTHING;

INSERT INTO tokens (owner_id, name, symbol, max_supply, circulating_supply, base_price, current_price, curve_k, is_featured)
SELECT u.id, 'NexDiamond', 'NXD', 400, 0, 67000, 67000, 1.5, true
FROM users u WHERE u.telegram_id = -1
ON CONFLICT (symbol) DO NOTHING;

INSERT INTO tokens (owner_id, name, symbol, max_supply, circulating_supply, base_price, current_price, curve_k, is_featured)
SELECT u.id, 'NexTitan', 'TITAN', 800, 0, 28500, 28500, 1.5, true
FROM users u WHERE u.telegram_id = -1
ON CONFLICT (symbol) DO NOTHING;

INSERT INTO tokens (owner_id, name, symbol, max_supply, circulating_supply, base_price, current_price, curve_k, is_featured)
SELECT u.id, 'NexPlatinum', 'PLAT', 500, 0, 52000, 52000, 1.5, true
FROM users u WHERE u.telegram_id = -1
ON CONFLICT (symbol) DO NOTHING;

INSERT INTO tokens (owner_id, name, symbol, max_supply, circulating_supply, base_price, current_price, curve_k, is_featured)
SELECT u.id, 'NexRoyal', 'ROYAL', 1000, 0, 12800, 12800, 1.5, true
FROM users u WHERE u.telegram_id = -1
ON CONFLICT (symbol) DO NOTHING;

-- ====== HAMYON (WALLET) - foydalanuvchilar orasida to'g'ridan-to'g'ri
-- Nex Trade jo'natish uchun ======
-- Har bir foydalanuvchiga o'ziga xos, o'zgarmas hamyon kodi (masalan NX-A1B2C3)
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_code VARCHAR(16) UNIQUE;

UPDATE users
SET wallet_code = 'NX-' || UPPER(SUBSTRING(MD5(id::text || telegram_id::text) FROM 1 FOR 6))
WHERE wallet_code IS NULL;

CREATE TABLE IF NOT EXISTS wallet_transfers (
    id SERIAL PRIMARY KEY,
    from_user_id INTEGER NOT NULL REFERENCES users(id),
    to_user_id INTEGER NOT NULL REFERENCES users(id),
    amount NUMERIC(20, 4) NOT NULL CHECK (amount > 0),
    note VARCHAR(140),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wallet_transfers_from ON wallet_transfers(from_user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transfers_to ON wallet_transfers(to_user_id);

-- ====== NEX TRADEX TO'LDIRISH / CHIQARISH ======
-- Avvalgi "Pul kiritish/chiqarish" (real bank kartasi) o'rniga - bu ICHKI
-- Nex Trade valyutasini to'g'ridan-to'g'ri (real to'lovsiz) to'ldirish/
-- chiqarish tarixi. Faqat audit/statistika uchun saqlanadi.
CREATE TABLE IF NOT EXISTS nex_topups (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount NUMERIC(20, 4) NOT NULL CHECK (amount > 0),
    uzs_value NUMERIC(20, 4) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nex_topups_user ON nex_topups(user_id);

CREATE TABLE IF NOT EXISTS nex_withdrawals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount NUMERIC(20, 4) NOT NULL CHECK (amount > 0),
    uzs_value NUMERIC(20, 4) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nex_withdrawals_user ON nex_withdrawals(user_id);

-- ====== TOKEN YARATUVCHI BONUSLARI (HAFTALIK YECHIB OLISH) ======
-- Endi savdo komissiyasidan yaratuvchiga tegishli ulush balansga DARHOL
-- tushmaydi - avval shu "kutilayotgan bonus" jamg'armasiga yig'iladi va
-- foydalanuvchi Profil > Bonuslar bo'limidan FAQAT HAFTADA 1 MARTA
-- (kamida 7 kunda bir) "Yechib olish" tugmasi orqali asosiy balansiga
-- o'tkaza oladi. Agar bir necha hafta yechib olinmasa, bonus jamg'arilib boraveradi.
CREATE TABLE IF NOT EXISTS creator_bonus_balance (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    amount NUMERIC(20, 8) NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS creator_bonus_claims (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount NUMERIC(20, 8) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_creator_bonus_claims_user_time ON creator_bonus_claims(user_id, created_at);

-- ====== TEZLIK UCHUN INDEKSLAR (v2) ======
-- Grafik (oxirgi 100 nuqta) va eski nuqtalarni tozalash so'rovlari uchun
CREATE INDEX IF NOT EXISTS idx_price_ticks_token_time ON price_ticks(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_ticks_time ON price_ticks(created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_token_time ON transactions(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
CREATE INDEX IF NOT EXISTS idx_nex_topups_user_time ON nex_topups(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_token_alerts_user ON token_alerts(user_id);

-- ====== v3: JALB QILISH FUNKSIYALARI ======
-- Kunlik bonus seriyasi (streak): ketma-ket necha kun bonus olingani
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_streak INTEGER NOT NULL DEFAULT 0;

-- Referal bonusi endi taklif qilingan do'st BIRINCHI SAVDOSINI qilganda beriladi.
-- Mavjud foydalanuvchilar eski tizimda bonusni olib bo'lgan - ular uchun true.
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_rewarded BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ALTER COLUMN referral_rewarded SET DEFAULT false;

-- Sotishdagi aniq foyda/zarar (haftalik liga shu asosda hisoblanadi)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS realized_pnl NUMERIC(20, 8);
CREATE INDEX IF NOT EXISTS idx_transactions_user_time ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_time ON transactions(created_at);

-- Vazifalar: har bir vazifa har davr (kun yoki bir martalik) uchun bir marta olinadi
CREATE TABLE IF NOT EXISTS mission_claims (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    mission_id VARCHAR(32) NOT NULL,
    period_key VARCHAR(16) NOT NULL,
    reward NUMERIC(20, 4) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, mission_id, period_key)
);

-- Haftalik liga mukofotlari (har hafta, har o'rin uchun faqat bir marta)
CREATE TABLE IF NOT EXISTS league_payouts (
    id SERIAL PRIMARY KEY,
    week_key VARCHAR(16) NOT NULL,
    rank INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id),
    pnl NUMERIC(20, 8) NOT NULL DEFAULT 0,
    reward NUMERIC(20, 4) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(week_key, rank)
);

-- Kanalga "+50%" e'lonlari uchun oxirgi e'lon qilingan narx
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS last_announced_price NUMERIC(20, 8);
CREATE INDEX IF NOT EXISTS idx_favorites_user_time ON favorites(user_id, created_at);

-- ====== v4: MODERATSIYA, STARS, G'ILDIRAK, IZOHLAR, LIMIT BUYURTMALAR ======
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_blocked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_spin_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS language VARCHAR(4);

-- Admin tomonidan yashirilgan (bloklangan) tokenlar va Stars orqali reklama
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS promoted_until TIMESTAMP;

-- Telegram Stars to'lovlari (charge_id UNIQUE - bir to'lov ikki marta qo'llanmaydi)
CREATE TABLE IF NOT EXISTS stars_payments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_id INTEGER REFERENCES tokens(id),
    kind VARCHAR(16) NOT NULL,
    stars INTEGER NOT NULL,
    charge_id VARCHAR(128) NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Omad g'ildiragi tarixi
CREATE TABLE IF NOT EXISTS wheel_spins (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    reward NUMERIC(20, 4) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wheel_spins_user ON wheel_spins(user_id);

-- Token izohlari
CREATE TABLE IF NOT EXISTS token_comments (
    id SERIAL PRIMARY KEY,
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    text VARCHAR(280) NOT NULL,
    is_deleted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_comments_token_time ON token_comments(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_comments_user_time ON token_comments(user_id, created_at DESC);

-- Limit buyurtmalar: narx belgilangan darajaga yetganda avtomatik savdo
CREATE TABLE IF NOT EXISTS limit_orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_id INTEGER NOT NULL REFERENCES tokens(id),
    side VARCHAR(4) NOT NULL CHECK (side IN ('buy', 'sell')),
    amount NUMERIC(20, 4) NOT NULL CHECK (amount > 0),
    trigger_price NUMERIC(20, 8) NOT NULL CHECK (trigger_price > 0),
    status VARCHAR(12) NOT NULL DEFAULT 'open',
    note TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    filled_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_limit_orders_open ON limit_orders(token_id, status);
CREATE INDEX IF NOT EXISTS idx_limit_orders_user ON limit_orders(user_id, status);
