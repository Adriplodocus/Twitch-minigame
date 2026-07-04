# Pack Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give packs granted via sub/gift-sub/bits/paypal ("apoyo" tier, chosen by the admin at grant time) better card odds than the free channel-point-redemption packs ("gratis" tier).

**Architecture:** A new `packs.tier` column (`gratis` | `apoyo`, default `gratis`) drives which rarity/shiny weight table `pickRandomCards` uses when a pack is opened. The automatic reward-redemption path always creates `gratis` packs (unchanged). The admin grant-packs UI gets an explicit tier selector, defaulting to `gratis`.

**Tech Stack:** Cloudflare Workers (Hono), D1 (SQLite), Vitest (`@cloudflare/vitest-pool-workers` for route tests, plain node for lib tests), vanilla TS frontend.

## Global Constraints

- Gratis tier weights: `common 71.5 / rare 15 / epic 12 / legendary 1.5`, shiny `0.5%`.
- Apoyo tier weights: `common 60 / rare 20 / epic 16 / legendary 4`, shiny `1%`.
- Category weights (`inicial 5% / mega 3% / gmax 3%`) are unchanged and identical across both tiers.
- No changes to Twitch EventSub scopes or PayPal integration — tier is chosen manually by the admin at grant time.
- Admin grant-packs UI tier selector defaults to `gratis`.

---

### Task 1: `packs.tier` column + tier-aware weighting in `worker/lib/packs.ts`

**Files:**
- Create: `migrations/0009_pack_tier.sql`
- Modify: `worker/lib/packs.ts` (full rewrite of exports)
- Modify: `worker/lib/packs.test.ts` (add `tier` arg to every existing call, update numbers/comments, add tier-specific tests)
- Modify: `test/lib/packs.test.ts` (update `RARITY_WEIGHTS` import → `RARITY_WEIGHTS_BY_TIER`, add `tier` arg to every call)

**Interfaces:**
- Produces: `export type PackTier = "gratis" | "apoyo"`, `export const RARITY_WEIGHTS_BY_TIER: Record<PackTier, Record<Rarity, number>>`, `export const SHINY_CHANCE_BY_TIER: Record<PackTier, number>`, `export function pickRandomCards<T extends { id: string; rarity: Rarity; category: Category }>(catalog: T[], count: number, tier: PackTier, random?: () => number): T[]` (note: `tier` is now a required 3rd positional argument, `random` shifts to 4th).

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE packs ADD COLUMN tier TEXT NOT NULL DEFAULT 'gratis'
  CHECK (tier IN ('gratis', 'apoyo'));
```

Save as `migrations/0009_pack_tier.sql`.

- [ ] **Step 2: Update `worker/lib/packs.test.ts` to the new tier-aware API (failing first)**

Replace the full file with:

```ts
import { describe, expect, it } from "vitest";
import { pickRandomCards, RARITY_WEIGHTS_BY_TIER, SHINY_CHANCE_BY_TIER } from "./packs";

interface TestCard {
  id: string;
  rarity: "common" | "rare" | "epic" | "legendary";
  category: "normal" | "inicial" | "mega" | "gmax";
}

function sequenceRandom(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("pickRandomCards", () => {
  it("throws on an empty catalog", () => {
    expect(() => pickRandomCards([], 1, "gratis")).toThrow();
  });

  it("picks shiny cards ~1% of the time within a rarity (apoyo tier), uniform among non-shiny", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal" },
      { id: "p2", rarity: "common", category: "normal" },
      { id: "p3", rarity: "common", category: "normal" },
      { id: "p1-shiny", rarity: "common", category: "normal" },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, "apoyo", sequenceRandom(rolls));
    const shinyCount = picks.filter((c) => c.id === "p1-shiny").length;
    const shinyRatio = shinyCount / picks.length;
    expect(shinyRatio).toBeGreaterThan(0.005);
    expect(shinyRatio).toBeLessThan(0.015);

    const p1 = picks.filter((c) => c.id === "p1").length;
    const p2 = picks.filter((c) => c.id === "p2").length;
    const p3 = picks.filter((c) => c.id === "p3").length;
    expect(p1).toBeCloseTo(p2, -2);
    expect(p2).toBeCloseTo(p3, -2);
  });

  it("picks shiny cards ~0.5% of the time within a rarity (gratis tier)", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal" },
      { id: "p1-shiny", rarity: "common", category: "normal" },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, "gratis", sequenceRandom(rolls));
    const shinyRatio = picks.filter((c) => c.id === "p1-shiny").length / picks.length;
    expect(shinyRatio).toBeGreaterThan(0.002);
    expect(shinyRatio).toBeLessThan(0.008);
  });

  it("gives shiny cards 0% chance if none exist for that rarity", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "rare", category: "normal" },
      { id: "p2", rarity: "rare", category: "normal" },
    ];
    const picks = pickRandomCards(catalog, 100, "gratis", () => 0.99);
    expect(picks.every((c) => !c.id.includes("-shiny"))).toBe(true);
  });

  it("still picks shiny cards if a rarity has only shiny variants", () => {
    const catalog: TestCard[] = [{ id: "p1-shiny", rarity: "legendary", category: "normal" }];
    const picks = pickRandomCards(catalog, 5, "gratis", () => 0.5);
    expect(picks.every((c) => c.id === "p1-shiny")).toBe(true);
  });

  it("respects gratis tier rarity weights (common 71.5 vs legendary 1.5)", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal" },
      { id: "p2", rarity: "legendary", category: "normal" },
    ];
    // common weight 71.5, legendary weight 1.5, total 73 -> common cutoff at roll < 71.5/73
    const picks = pickRandomCards(catalog, 1, "gratis", () => 0.5);
    expect(picks[0].id).toBe("p1");

    const legendaryPick = pickRandomCards(catalog, 1, "gratis", () => 0.999);
    expect(legendaryPick[0].id).toBe("p2");
  });

  it("gives legendary a noticeably better chance in apoyo tier than gratis tier", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal" },
      { id: "p2", rarity: "legendary", category: "normal" },
    ];
    // apoyo: common 60, legendary 4, total 64 -> a roll that stays "common" under gratis
    // (71.5/73 ≈ 0.979) should flip to legendary under apoyo (60/64 = 0.9375).
    const roll = 0.96;
    expect(pickRandomCards(catalog, 1, "gratis", () => roll)[0].id).toBe("p1");
    expect(pickRandomCards(catalog, 1, "apoyo", () => roll)[0].id).toBe("p2");
  });

  it("splits a rarity's weight budget across categories ~89/5/3/3 (normal/inicial/mega/gmax), independent of tier", () => {
    const catalog: TestCard[] = [
      { id: "normal1", rarity: "common", category: "normal" },
      { id: "inicial1", rarity: "common", category: "inicial" },
      { id: "mega1", rarity: "common", category: "mega" },
      { id: "gmax1", rarity: "common", category: "gmax" },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, "gratis", sequenceRandom(rolls));
    const ratio = (id: string) => picks.filter((c) => c.id === id).length / picks.length;

    expect(ratio("normal1")).toBeGreaterThan(0.87);
    expect(ratio("normal1")).toBeLessThan(0.91);
    expect(ratio("inicial1")).toBeGreaterThan(0.03);
    expect(ratio("inicial1")).toBeLessThan(0.07);
    expect(ratio("mega1")).toBeGreaterThan(0.01);
    expect(ratio("mega1")).toBeLessThan(0.05);
    expect(ratio("gmax1")).toBeGreaterThan(0.01);
    expect(ratio("gmax1")).toBeLessThan(0.05);
  });

  it("folds an absent category's weight budget entirely into normal for that rarity", () => {
    const catalog: TestCard[] = [
      { id: "normal1", rarity: "rare", category: "normal" },
      { id: "inicial1", rarity: "rare", category: "inicial" },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, "gratis", sequenceRandom(rolls));
    const ratio = (id: string) => picks.filter((c) => c.id === id).length / picks.length;

    expect(ratio("normal1")).toBeGreaterThan(0.93);
    expect(ratio("normal1")).toBeLessThan(0.97);
    expect(ratio("inicial1")).toBeGreaterThan(0.03);
    expect(ratio("inicial1")).toBeLessThan(0.07);
  });

  it("applies shiny within a non-normal category too", () => {
    const catalog: TestCard[] = [
      { id: "mega1", rarity: "epic", category: "mega" },
      { id: "mega1-shiny", rarity: "epic", category: "mega" },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, "apoyo", sequenceRandom(rolls));
    const shinyRatio = picks.filter((c) => c.id === "mega1-shiny").length / picks.length;
    expect(shinyRatio).toBeGreaterThan(0.005);
    expect(shinyRatio).toBeLessThan(0.015);
  });

  it("exposes the exact per-tier weight tables from the spec", () => {
    expect(RARITY_WEIGHTS_BY_TIER.gratis).toEqual({ common: 71.5, rare: 15, epic: 12, legendary: 1.5 });
    expect(RARITY_WEIGHTS_BY_TIER.apoyo).toEqual({ common: 60, rare: 20, epic: 16, legendary: 4 });
    expect(SHINY_CHANCE_BY_TIER.gratis).toBe(0.005);
    expect(SHINY_CHANCE_BY_TIER.apoyo).toBe(0.01);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:worker -- packs.test.ts`
Expected: FAIL — `pickRandomCards` doesn't accept a `tier` argument yet, `RARITY_WEIGHTS_BY_TIER`/`SHINY_CHANCE_BY_TIER` don't exist.

- [ ] **Step 4: Update `test/lib/packs.test.ts` to the new API (also failing)**

Replace the full file with:

```ts
import { it, expect } from "vitest";
import { pickRandomCards, RARITY_WEIGHTS_BY_TIER } from "../../worker/lib/packs";

const catalog = [
  { id: "c1", rarity: "common" as const, category: "normal" as const },
  { id: "r1", rarity: "rare" as const, category: "normal" as const },
  { id: "e1", rarity: "epic" as const, category: "normal" as const },
  { id: "l1", rarity: "legendary" as const, category: "normal" as const },
];

it("returns the requested number of cards", () => {
  const picks = pickRandomCards(catalog, 5, "gratis", () => 0.5);
  expect(picks).toHaveLength(5);
});

it("picks the first card when random() returns 0", () => {
  const picks = pickRandomCards(catalog, 1, "gratis", () => 0);
  expect(picks[0].id).toBe("c1");
});

it("picks the last card when random() returns just under 1", () => {
  const picks = pickRandomCards(catalog, 1, "gratis", () => 0.999999);
  expect(picks[0].id).toBe("l1");
});

it("throws on an empty catalog", () => {
  expect(() => pickRandomCards([], 5, "gratis")).toThrow();
});

it("defines descending weights per rarity within each tier", () => {
  for (const tier of ["gratis", "apoyo"] as const) {
    const weights = RARITY_WEIGHTS_BY_TIER[tier];
    expect(weights.common).toBeGreaterThan(weights.rare);
    expect(weights.rare).toBeGreaterThan(weights.epic);
    expect(weights.epic).toBeGreaterThan(weights.legendary);
  }
});
```

- [ ] **Step 5: Run both suites to confirm they still fail for the same reason**

Run: `npm run test:worker`
Expected: FAIL in `worker/lib/packs.ts` — module doesn't export `PackTier`/`RARITY_WEIGHTS_BY_TIER`/`SHINY_CHANCE_BY_TIER`, and `pickRandomCards` signature mismatch.

- [ ] **Step 6: Implement the tier-aware `worker/lib/packs.ts`**

Replace the full file with:

```ts
import type { Category, Rarity } from "../types";

export type PackTier = "gratis" | "apoyo";

export const RARITY_WEIGHTS_BY_TIER: Record<PackTier, Record<Rarity, number>> = {
  gratis: { common: 71.5, rare: 15, epic: 12, legendary: 1.5 },
  apoyo: { common: 60, rare: 20, epic: 16, legendary: 4 },
};

export const SHINY_CHANCE_BY_TIER: Record<PackTier, number> = {
  gratis: 0.005,
  apoyo: 0.01,
};

export const CATEGORY_WEIGHTS: Record<Exclude<Category, "normal">, number> = {
  inicial: 0.05,
  mega: 0.03,
  gmax: 0.03,
};

export function isShinyCard(id: string): boolean {
  return id.includes("-shiny");
}

function splitShinyWeight(
  rarityWeight: number,
  shinyCount: number,
  nonShinyCount: number,
  shiny: boolean,
  shinyChance: number
): number {
  if (shinyCount === 0) return shiny ? 0 : rarityWeight / nonShinyCount;
  if (nonShinyCount === 0) return shiny ? rarityWeight / shinyCount : 0;
  return shiny ? (rarityWeight * shinyChance) / shinyCount : (rarityWeight * (1 - shinyChance)) / nonShinyCount;
}

function buildCardWeights<T extends { id: string; rarity: Rarity; category: Category }>(
  catalog: T[],
  tier: PackTier
): Map<T, number> {
  const rarityWeights = RARITY_WEIGHTS_BY_TIER[tier];
  const shinyChance = SHINY_CHANCE_BY_TIER[tier];

  // Count cards per (rarity, category) bucket, split further into shiny/non-shiny.
  const countsByRarityCategory = new Map<Rarity, Map<Category, { shiny: number; nonShiny: number }>>();
  for (const card of catalog) {
    let byCategory = countsByRarityCategory.get(card.rarity);
    if (!byCategory) {
      byCategory = new Map();
      countsByRarityCategory.set(card.rarity, byCategory);
    }
    let counts = byCategory.get(card.category);
    if (!counts) {
      counts = { shiny: 0, nonShiny: 0 };
      byCategory.set(card.category, counts);
    }
    if (isShinyCard(card.id)) counts.shiny++;
    else counts.nonShiny++;
  }

  const weights = new Map<T, number>();
  for (const [rarity, byCategory] of countsByRarityCategory) {
    const rarityWeight = rarityWeights[rarity];

    // Only categories that actually have >=1 card in this rarity reserve their budget;
    // absent categories fold their share entirely into "normal".
    let normalFraction = 1;
    for (const [category, weightFraction] of Object.entries(CATEGORY_WEIGHTS) as [Exclude<Category, "normal">, number][]) {
      if (byCategory.has(category)) normalFraction -= weightFraction;
    }

    for (const [category, counts] of byCategory) {
      const categoryFraction = category === "normal" ? normalFraction : CATEGORY_WEIGHTS[category];
      const categoryBudget = rarityWeight * categoryFraction;

      for (const card of catalog) {
        if (card.rarity !== rarity || card.category !== category) continue;
        const shiny = isShinyCard(card.id);
        weights.set(card, splitShinyWeight(categoryBudget, counts.shiny, counts.nonShiny, shiny, shinyChance));
      }
    }
  }
  return weights;
}

export function pickRandomCards<T extends { id: string; rarity: Rarity; category: Category }>(
  catalog: T[],
  count: number,
  tier: PackTier,
  random: () => number = Math.random
): T[] {
  if (catalog.length === 0) throw new Error("Catalog is empty");
  const weights = buildCardWeights(catalog, tier);
  const totalWeight = catalog.reduce((sum, card) => sum + weights.get(card)!, 0);
  const picks: T[] = [];
  for (let i = 0; i < count; i++) {
    let roll = random() * totalWeight;
    let chosen = catalog[catalog.length - 1];
    for (const card of catalog) {
      roll -= weights.get(card)!;
      if (roll <= 0) {
        chosen = card;
        break;
      }
    }
    picks.push(chosen);
  }
  return picks;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test:worker`
Expected: PASS (all `packs.test.ts` suites, both locations)

- [ ] **Step 8: Commit**

```bash
git add migrations/0009_pack_tier.sql worker/lib/packs.ts worker/lib/packs.test.ts test/lib/packs.test.ts
git commit -m "feat: add gratis/apoyo pack tiers with per-tier odds"
```

---

### Task 2: Wire `tier` through the collection-open and admin-grant routes

**Files:**
- Modify: `worker/routes/collection.ts:30-90` (`/packs/:id/open`)
- Modify: `worker/routes/admin.ts:59-88` (`/grant-packs`, `/history`)
- Modify: `test/routes/collection.test.ts` (add a tier-wiring test)
- Modify: `test/routes/admin.test.ts` (require `tier` in grant-packs, add invalid-tier test, assert tier in history)
- Modify: `test/routes/webhook.test.ts:88-120` (assert reward packs default to `tier = 'gratis'`)

**Interfaces:**
- Consumes: `pickRandomCards(catalog, count, tier, random?)`, `PackTier` from `worker/lib/packs.ts` (Task 1).
- Produces: `POST /api/admin/grant-packs` now requires `{ twitchId, quantity, tier }` in the body; `GET /api/admin/history` responses include `tier` per row.

- [ ] **Step 1: Add a failing test for admin grant-packs requiring `tier`**

In `test/routes/admin.test.ts`, replace the existing `"grants packs with source 'admin' and lists them in history"` test and the `"rejects grant-packs with an out-of-range quantity"` test's body, and add two new tests. The relevant block becomes:

```ts
it("rejects grant-packs with an out-of-range quantity", async () => {
  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "1", quantity: 0, tier: "gratis" }),
    },
    env
  );
  expect(res.status).toBe(400);
});

it("rejects grant-packs with a missing or invalid tier", async () => {
  const cookie = await adminCookie();
  const missingTier = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "1", quantity: 1 }),
    },
    env
  );
  expect(missingTier.status).toBe(400);

  const invalidTier = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "1", quantity: 1, tier: "premium" }),
    },
    env
  );
  expect(invalidTier.status).toBe(400);
});

it("rejects grant-packs for a nonexistent user", async () => {
  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "does-not-exist", quantity: 1, tier: "gratis" }),
    },
    env
  );
  expect(res.status).toBe(404);
});

it("grants packs with the chosen tier and lists them in history", async () => {
  const cookie = await adminCookie();
  const res = await app.request(
    "/api/admin/grant-packs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ twitchId: "1", quantity: 3, tier: "apoyo" }),
    },
    env
  );
  expect(res.status).toBe(200);

  const packs = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?")
    .bind("1")
    .all<{ source: string; tier: string }>();
  expect(packs.results).toHaveLength(3);
  expect(packs.results.every((p) => p.source === "admin" && p.tier === "apoyo")).toBe(true);

  const historyRes = await app.request("/api/admin/history", { headers: { Cookie: cookie } }, env);
  const historyJson = await historyRes.json<{ history: { username: string; tier: string }[] }>();
  expect(historyJson.history).toHaveLength(3);
  expect(historyJson.history[0].username).toBe("viewer1");
  expect(historyJson.history[0].tier).toBe("apoyo");
});
```

- [ ] **Step 2: Add a failing test confirming the open route reads a pack's tier**

Append to `test/routes/collection.test.ts`:

```ts
it("opens a pack using its stored tier without erroring", async () => {
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id, tier) VALUES (?, 'apoyo') RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 1 }),
    },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ cards: { id: string }[] }>();
  expect(json.cards).toHaveLength(10);
});
```

- [ ] **Step 3: Add a failing assertion that reward packs default to `tier = 'gratis'`**

In `test/routes/webhook.test.ts`, in the `"defaults new pack rows to source 'reward'"` test (around line 88), replace the final query and assertion (lines 117-120):

```ts
  const pack = await env.DB.prepare("SELECT source, tier FROM packs WHERE user_id = ?")
    .bind("42")
    .first<{ source: string; tier: string }>();
  expect(pack?.source).toBe("reward");
  expect(pack?.tier).toBe("gratis");
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm run test:worker -- admin.test.ts collection.test.ts webhook.test.ts`
Expected: FAIL — `grant-packs` doesn't require/accept `tier` yet, `/history` doesn't return `tier`, collection open ignores `pack.tier`.

- [ ] **Step 5: Update `worker/routes/admin.ts`**

Replace lines 59-88 with:

```ts
admin.post("/grant-packs", requireAdmin, async (c) => {
  const body = await c.req
    .json<{ twitchId?: string; quantity?: number; tier?: string }>()
    .catch(() => ({}) as { twitchId?: string; quantity?: number; tier?: string });
  const { twitchId, quantity, tier } = body;

  if (!twitchId || typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
    return c.json({ error: "Invalid twitchId or quantity" }, 400);
  }
  if (tier !== "gratis" && tier !== "apoyo") {
    return c.json({ error: "Invalid tier" }, 400);
  }

  const user = await c.env.DB.prepare("SELECT twitch_id FROM users WHERE twitch_id = ?").bind(twitchId).first();
  if (!user) return c.json({ error: "User not found" }, 404);

  const statements = Array.from({ length: quantity }, () =>
    c.env.DB.prepare("INSERT INTO packs (user_id, source, tier) VALUES (?, 'admin', ?)").bind(twitchId, tier)
  );
  await c.env.DB.batch(statements);

  return c.json({ ok: true });
});

admin.get("/history", requireAdmin, async (c) => {
  const history = await c.env.DB.prepare(
    `SELECT p.id, p.user_id AS userId, u.username, p.tier AS tier, p.created_at AS createdAt
     FROM packs p JOIN users u ON u.twitch_id = p.user_id
     WHERE p.source = 'admin'
     ORDER BY p.created_at DESC LIMIT 20`
  ).all<{ id: number; userId: string; username: string; tier: string; createdAt: string }>();
  return c.json({ history: history.results });
});
```

- [ ] **Step 6: Update `worker/routes/collection.ts`**

In the `/packs/:id/open` handler, change the pack `SELECT` (line 34) and the `pickRandomCards` call (line 62):

```ts
  const pack = await c.env.DB.prepare("SELECT id, user_id, opened_at, tier FROM packs WHERE id = ?")
    .bind(packId)
    .first<{ id: number; user_id: string; opened_at: string | null; tier: "gratis" | "apoyo" }>();
  if (!pack || pack.user_id !== user.twitchId) return c.json({ error: "Not found" }, 404);
  if (pack.opened_at) return c.json({ error: "Pack already opened" }, 409);
```

```ts
  const picked = pickRandomCards(catalog.results, 10, pack.tier);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test:worker`
Expected: PASS (all suites, including the untouched pre-existing tests)

- [ ] **Step 8: Commit**

```bash
git add worker/routes/admin.ts worker/routes/collection.ts test/routes/admin.test.ts test/routes/collection.test.ts test/routes/webhook.test.ts
git commit -m "feat: require tier on pack grants, apply it on pack open"
```

---

### Task 3: Admin UI — tier selector and history column

**Files:**
- Modify: `admin.html:44-80`
- Modify: `src/admin.ts` (full file, see interfaces below)

**Interfaces:**
- Consumes: `POST /api/admin/grant-packs` body now requires `tier: "gratis" | "apoyo"` (Task 2); `GET /api/admin/history` rows now include `tier: string` (Task 2).
- Produces: none consumed by later tasks (this is the last task in the plan).

- [ ] **Step 1: Add the tier `<select>` and a Tier history column in `admin.html`**

Replace the quantity/grant row (lines 45-49) with:

```html
          <input
            class="input"
            id="search-input"
            placeholder="Buscar username de Twitch"
            style="margin-top: 0.75rem; width: 100%; max-width: 320px;"
          />
          <div id="search-results" style="margin-top: 0.5rem;"></div>

          <div id="selected-user" style="display: none; margin-top: 0.75rem; align-items: center; gap: 0.5rem;">
            <span class="badge" id="selected-user-name"></span>
            <button class="btn" id="clear-selection-btn" style="padding: 0.3rem 0.8rem;">x</button>
          </div>

          <div style="margin-top: 0.75rem; display: flex; align-items: center; gap: 0.5rem;">
            <input class="input" id="quantity-input" type="number" min="1" max="50" value="1" style="width: 80px;" />
            <select class="input" id="tier-select">
              <option value="gratis">Gratis</option>
              <option value="apoyo">Apoyo</option>
            </select>
            <button class="btn" id="grant-btn" disabled>Dar blíster(s)</button>
          </div>
          <p id="grant-message" style="margin-top: 0.5rem;"></p>
```

And the Historial table header (lines 71-77):

```html
          <table style="width: 100%; margin-top: 0.75rem; border-collapse: collapse;">
            <thead>
              <tr>
                <th style="text-align: left; padding: 0.4rem;">Usuario</th>
                <th style="text-align: left; padding: 0.4rem;">Tier</th>
                <th style="text-align: left; padding: 0.4rem;">Fecha</th>
              </tr>
            </thead>
            <tbody id="history-body"></tbody>
          </table>
```

- [ ] **Step 2: Update `src/admin.ts` to read/send/display tier**

Update the `HistoryRow` interface (lines 7-12):

```ts
interface HistoryRow {
  id: number;
  userId: string;
  username: string;
  tier: string;
  createdAt: string;
}
```

Update `renderHistory` (lines 38-53) to add a tier cell:

```ts
function renderHistory(history: HistoryRow[]): void {
  const container = document.getElementById("history-body")!;
  const rows = history.map((h) => {
    const tr = document.createElement("tr");
    const tdUsername = document.createElement("td");
    tdUsername.style.padding = "0.4rem";
    tdUsername.textContent = h.username;
    const tdTier = document.createElement("td");
    tdTier.style.padding = "0.4rem";
    tdTier.textContent = h.tier;
    const tdCreatedAt = document.createElement("td");
    tdCreatedAt.style.padding = "0.4rem";
    tdCreatedAt.textContent = h.createdAt;
    tr.appendChild(tdUsername);
    tr.appendChild(tdTier);
    tr.appendChild(tdCreatedAt);
    return tr;
  });
  container.replaceChildren(...rows);
}
```

Update `performGrant` and `grantPacks` (lines 150-181) to thread `tier` through:

```ts
async function performGrant(twitchId: string, quantity: number, tier: string, username: string): Promise<boolean> {
  const messageEl = document.getElementById("grant-message")!;

  const confirmed = await showConfirmModal(quantity, username);
  if (!confirmed) return false;

  const result = await request<{ ok: true }>("/grant-packs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ twitchId, quantity, tier }),
  });

  if (!result.ok) {
    if (result.status === 401) {
      showLoginView();
      return false;
    }
    messageEl.textContent = "Error al dar blíster(s).";
    return false;
  }

  messageEl.textContent = `Blíster(s) entregado(s) a ${username}.`;
  await loadHistory();
  return true;
}

async function grantPacks(): Promise<void> {
  if (!selectedUser) return;
  const quantity = Number((document.getElementById("quantity-input") as HTMLInputElement).value);
  const tier = (document.getElementById("tier-select") as HTMLSelectElement).value;
  const succeeded = await performGrant(selectedUser.twitchId, quantity, tier, selectedUser.username);
  if (succeeded) clearSelection();
}
```

Update the quick "+1 blíster" button in `renderAllUsers` (line 197) to default to `"gratis"`:

```ts
    grantBtn.addEventListener("click", () => performGrant(u.twitchId, 1, "gratis", u.username));
```

- [ ] **Step 3: Typecheck the frontend build**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: no errors

- [ ] **Step 4: Manual check**

Run: `npm run dev`, open `/admin.html`, log in, select a user, confirm the tier `<select>` shows Gratis/Apoyo (defaulting to Gratis), grant a pack with each tier, and confirm the Historial table shows the correct tier per row.

- [ ] **Step 5: Commit**

```bash
git add admin.html src/admin.ts
git commit -m "feat: add tier selector and column to admin panel"
```

---

## Self-Review Notes

- Spec coverage: migration + weight tables (Task 1), reward path stays `gratis` by default with an explicit regression test (Task 2 Step 3), admin grant requires explicit tier defaulting to `gratis` in the UI (Task 3), category weights unchanged and covered by an existing test re-run under the new tier param (Task 1) — all spec sections have a corresponding task.
- Both duplicate pack-weight test files (`worker/lib/packs.test.ts` and `test/lib/packs.test.ts`) are updated together since both import from `worker/lib/packs.ts` and both run under `npm run test:worker`.
- Out of scope, confirmed not touched: Twitch EventSub scopes, PayPal integration, a 3rd "premium" tier.
