# Pack Odds Boost (paid with coins) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a viewer spend 150 coins, at the moment of opening a specific pending pack, to shift that pack's rarity and shiny odds halfway toward the next tier up (never worse than unboosted, even on `apoyo` packs).

**Architecture:** The boost is a fixed relative delta added on top of the pack's existing tier weights inside `worker/lib/packs.ts` — no new odds table. `POST /api/collection/packs/:id/open` gains an optional `boost` body field; when true it debits coins atomically (same `UPDATE ... WHERE coins >= ? RETURNING coins` pattern already used by `convert-shiny`) before drawing cards, and always returns the current `coins` balance so the frontend can refresh the header without an extra request. The frontend adds a checkbox to the existing generation-picker modal, wires the choice through to `openPack`, and reuses the `apoyo`-tier corner-ribbon visual (different icon/color) to flag a boosted pack during its opening animation.

**Tech Stack:** Hono + D1 (Cloudflare Workers), Miniflare test pool (`vitest.workers.config.ts`), plain TypeScript/Vite frontend, Vitest (`vitest.config.ts`) for frontend unit tests.

## Global Constraints

Spec: `docs/superpowers/specs/2026-07-20-pack-boost-design.md`

- `RARITY_BOOST_DELTA`: `{ common: -5.75, rare: 2.5, epic: 2, legendary: 1.25 }` (half the gratis↔apoyo gap per rarity).
- `SHINY_BOOST_DELTA`: `0.0025` (half the gratis↔apoyo shiny gap).
- `PACK_BOOST_COST`: `150` coins, flat regardless of pack tier.
- Boost is decided at `POST .../open` time, not persisted on the `packs` row — no "boost level", no permanent/account-wide boost.
- `admin.ts` (manual grants, test packs) is untouched — boost is a player-only action on their own pending packs.
- Response of `POST .../open` always includes `coins` now (previously just `{ cards }`).

---

### Task 1: Boosted odds in the pack-draw engine

**Files:**
- Modify: `worker/lib/packs.ts`
- Test: `worker/lib/packs.test.ts`

**Interfaces:**
- Produces: `RARITY_BOOST_DELTA: Record<Rarity, number>`, `SHINY_BOOST_DELTA: number` (exported constants).
- Produces: `pickRandomCards<T>(catalog: T[], count: number, tier: PackTier, boost: boolean, random: () => number = Math.random): T[]` — note `boost` is inserted **before** the existing `random` param, not after (existing call sites pass `random` positionally and must not silently receive a boolean where a function is expected).
- Produces: `buildCardWeights<T>(catalog: T[], tier: PackTier, boost: boolean): Map<T, number>` (internal, not exported — free to change signature).

- [ ] **Step 1: Write the failing tests**

Add to `worker/lib/packs.test.ts`, inside the existing `describe("pickRandomCards", ...)` block, right after the `"exposes the exact per-tier weight tables from the spec"` test:

```ts
  it("exposes the boost deltas from the spec", () => {
    expect(RARITY_BOOST_DELTA).toEqual({ common: -5.75, rare: 2.5, epic: 2, legendary: 1.25 });
    expect(SHINY_BOOST_DELTA).toBe(0.0025);
  });

  it("boosting a gratis pack lands rarity odds at the gratis/apoyo midpoint", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal", sortOrder: 1_000_000 },
      { id: "p2", rarity: "legendary", category: "normal", sortOrder: 2_000_000 },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, "gratis", true, sequenceRandom(rolls));
    const legendaryRatio = picks.filter((c) => c.id === "p2").length / picks.length;
    // Only two rarities in this catalog, so the weight pool is just their two boosted
    // weights: common 71.5-5.75=65.75, legendary 1.5+1.25=2.75 -> ratio 2.75/68.5 ≈ 0.040.
    expect(legendaryRatio).toBeGreaterThan(0.02);
    expect(legendaryRatio).toBeLessThan(0.05);
  });

  it("boosting an apoyo pack never makes rarity odds worse than unboosted apoyo", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal", sortOrder: 1_000_000 },
      { id: "p2", rarity: "legendary", category: "normal", sortOrder: 2_000_000 },
    ];
    const roll = 0.95;
    const unboosted = pickRandomCards(catalog, 1, "apoyo", false, () => roll)[0].id;
    const boosted = pickRandomCards(catalog, 1, "apoyo", true, () => roll)[0].id;
    // apoyo legendary share (4/64=0.0625) < boosted apoyo legendary share (5.25/64ish) for the same roll,
    // so any roll that already lands legendary unboosted must still land legendary boosted.
    if (unboosted === "p2") expect(boosted).toBe("p2");
  });

  it("boost=false leaves odds identical to the existing unboosted behavior", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal", sortOrder: 1_000_000 },
      { id: "p2", rarity: "legendary", category: "normal", sortOrder: 2_000_000 },
    ];
    const picks = pickRandomCards(catalog, 1, "gratis", false, () => 0.5);
    expect(picks[0].id).toBe("p1");
    const legendaryPick = pickRandomCards(catalog, 1, "gratis", false, () => 0.999);
    expect(legendaryPick[0].id).toBe("p2");
  });

  it("boosts shiny chance by the fixed delta on top of the tier's base chance", () => {
    const catalog: TestCard[] = [
      { id: "p1", rarity: "common", category: "normal", sortOrder: 1_000_000 },
      { id: "p1-shiny", rarity: "common", category: "normal", sortOrder: 1_000_000 },
    ];
    const rolls = Array.from({ length: 10000 }, (_, i) => i / 10000);
    const picks = pickRandomCards(catalog, rolls.length, "gratis", true, sequenceRandom(rolls));
    const shinyRatio = picks.filter((c) => c.id === "p1-shiny").length / picks.length;
    // gratis base 0.5% + boost delta 0.25% = 0.75%
    expect(shinyRatio).toBeGreaterThan(0.004);
    expect(shinyRatio).toBeLessThan(0.011);
  });
```

Update the import line at the top of `worker/lib/packs.test.ts`:

```ts
import { pickRandomCards, RARITY_WEIGHTS_BY_TIER, SHINY_CHANCE_BY_TIER, RARITY_BOOST_DELTA, SHINY_BOOST_DELTA } from "./packs";
```

Update every existing call site in this file that passes `random` as the 4th positional argument to instead pass `false` for `boost` and move `random` to the 5th slot. There are 12 call sites; every one changes from `pickRandomCards(catalog, N, tier, randomArg)` to `pickRandomCards(catalog, N, tier, false, randomArg)`, and the two calls that pass no random function at all (`pickRandomCards([], 1, "gratis")` and none else) become `pickRandomCards([], 1, "gratis", false)`. Concretely, replace each of these lines:

```ts
    expect(() => pickRandomCards([], 1, "gratis")).toThrow();
```
```ts
    expect(() => pickRandomCards([], 1, "gratis", false)).toThrow();
```

```ts
    const picks = pickRandomCards(catalog, rolls.length, "apoyo", sequenceRandom(rolls));
```
(appears twice, lines 29 and 136 — both become)
```ts
    const picks = pickRandomCards(catalog, rolls.length, "apoyo", false, sequenceRandom(rolls));
```

```ts
    const picks = pickRandomCards(catalog, rolls.length, "gratis", sequenceRandom(rolls));
```
(appears at lines 48, 102, 121, 159 — all become)
```ts
    const picks = pickRandomCards(catalog, rolls.length, "gratis", false, sequenceRandom(rolls));
```

```ts
    const picks = pickRandomCards(catalog, 100, "gratis", () => 0.99);
```
```ts
    const picks = pickRandomCards(catalog, 100, "gratis", false, () => 0.99);
```

```ts
    const picks = pickRandomCards(catalog, 5, "gratis", () => 0.5);
```
```ts
    const picks = pickRandomCards(catalog, 5, "gratis", false, () => 0.5);
```

```ts
    const picks = pickRandomCards(catalog, 1, "gratis", () => 0.5);
```
```ts
    const picks = pickRandomCards(catalog, 1, "gratis", false, () => 0.5);
```

```ts
    const legendaryPick = pickRandomCards(catalog, 1, "gratis", () => 0.999);
```
```ts
    const legendaryPick = pickRandomCards(catalog, 1, "gratis", false, () => 0.999);
```

```ts
    expect(pickRandomCards(catalog, 1, "gratis", () => roll)[0].id).toBe("p1");
    expect(pickRandomCards(catalog, 1, "apoyo", () => roll)[0].id).toBe("p2");
```
```ts
    expect(pickRandomCards(catalog, 1, "gratis", false, () => roll)[0].id).toBe("p1");
    expect(pickRandomCards(catalog, 1, "apoyo", false, () => roll)[0].id).toBe("p2");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.workers.config.ts worker/lib/packs.test.ts`
Expected: FAIL — `RARITY_BOOST_DELTA`/`SHINY_BOOST_DELTA` not exported, `pickRandomCards` signature mismatch (too many/wrong-typed args) on the new tests; the updated existing calls also fail to compile/run until Step 3 lands.

- [ ] **Step 3: Implement the boost in `worker/lib/packs.ts`**

Add right after `SHINY_CHANCE_BY_TIER`:

```ts
export const RARITY_BOOST_DELTA: Record<Rarity, number> = {
  common: -5.75,
  rare: 2.5,
  epic: 2,
  legendary: 1.25,
};

export const SHINY_BOOST_DELTA = 0.0025;
```

Change `buildCardWeights`'s signature and its two internal reads of `rarityWeights`/`shinyChance`:

```ts
function buildCardWeights<T extends { id: string; rarity: Rarity; category: Category; sortOrder: number }>(
  catalog: T[],
  tier: PackTier,
  boost: boolean
): Map<T, number> {
  const rarityWeights = boost
    ? Object.fromEntries(
        (Object.entries(RARITY_WEIGHTS_BY_TIER[tier]) as [Rarity, number][]).map(([rarity, weight]) => [
          rarity,
          weight + RARITY_BOOST_DELTA[rarity],
        ])
      ) as Record<Rarity, number>
    : RARITY_WEIGHTS_BY_TIER[tier];
  const shinyChance = SHINY_CHANCE_BY_TIER[tier] + (boost ? SHINY_BOOST_DELTA : 0);
```

(the rest of `buildCardWeights` is unchanged — it already reads from the local `rarityWeights`/`shinyChance` variables).

Change `pickRandomCards`'s signature and its call into `buildCardWeights`:

```ts
export function pickRandomCards<T extends { id: string; rarity: Rarity; category: Category; sortOrder: number }>(
  catalog: T[],
  count: number,
  tier: PackTier,
  boost: boolean,
  random: () => number = Math.random
): T[] {
  if (catalog.length === 0) throw new Error("Catalog is empty");
  const weights = buildCardWeights(catalog, tier, boost);
```

(the loop below stays identical).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts worker/lib/packs.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add worker/lib/packs.ts worker/lib/packs.test.ts
git commit -m "feat: add boosted pack odds to the draw engine"
```

---

### Task 2: `PACK_BOOST_COST` and the boosted-open endpoint

**Files:**
- Modify: `worker/lib/coins.ts`
- Modify: `worker/routes/collection.ts:127-186` (the `collection.post("/packs/:id/open", ...)` handler)
- Test: `test/routes/collection.test.ts`

**Interfaces:**
- Consumes: `pickRandomCards(catalog, count, tier, boost, random?)` from Task 1.
- Produces: `worker/lib/coins.ts` exports `PACK_BOOST_COST = 150`.
- Produces: `POST /api/collection/packs/:id/open` response becomes `{ cards: CardView[]; coins: number }` (was `{ cards }`); accepts optional `boost: boolean` in the request body; returns `400 { error: "Not enough coins" }` when `boost: true` and the user has `< 150` coins, without opening the pack.

- [ ] **Step 1: Write the failing tests**

Add to `test/routes/collection.test.ts`, after the existing `"opens a pending pack and grants 10 cards"` test:

```ts
it("includes the caller's coin balance in the open response", async () => {
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(300, "1").run();
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
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
  const json = await res.json<{ coins: number }>();
  expect(json.coins).toBe(300);
});

it("debits 150 coins and opens the pack when boost is requested with enough coins", async () => {
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(200, "1").run();
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 1, boost: true }),
    },
    env
  );
  expect(res.status).toBe(200);
  const json = await res.json<{ cards: { id: string }[]; coins: number }>();
  expect(json.cards).toHaveLength(10);
  expect(json.coins).toBe(50);

  const pack = await env.DB.prepare("SELECT opened_at FROM packs WHERE id = ?")
    .bind(packResult!.id)
    .first<{ opened_at: string | null }>();
  expect(pack?.opened_at).not.toBeNull();
});

it("rejects boosting without enough coins and leaves the pack unopened", async () => {
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(100, "1").run();
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  const res = await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 1, boost: true }),
    },
    env
  );
  expect(res.status).toBe(400);
  const json = await res.json<{ error: string }>();
  expect(json.error).toBe("Not enough coins");

  const pack = await env.DB.prepare("SELECT opened_at FROM packs WHERE id = ?")
    .bind(packResult!.id)
    .first<{ opened_at: string | null }>();
  expect(pack?.opened_at).toBeNull();
  const user = await env.DB.prepare("SELECT coins FROM users WHERE twitch_id = ?").bind("1").first<{ coins: number }>();
  expect(user?.coins).toBe(100);
});

it("does not touch coins when boost is omitted", async () => {
  await env.DB.prepare("UPDATE users SET coins = ? WHERE twitch_id = ?").bind(300, "1").run();
  const packResult = await env.DB.prepare("INSERT INTO packs (user_id) VALUES (?) RETURNING id")
    .bind("1")
    .first<{ id: number }>();

  const cookie = await sessionCookie("1", "viewer1");
  await app.request(
    `/api/collection/packs/${packResult!.id}/open`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ generation: 1 }),
    },
    env
  );
  const user = await env.DB.prepare("SELECT coins FROM users WHERE twitch_id = ?").bind("1").first<{ coins: number }>();
  expect(user?.coins).toBe(300);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/collection.test.ts`
Expected: FAIL — response has no `coins` field yet, `boost` is ignored, `PACK_BOOST_COST` doesn't exist.

- [ ] **Step 3: Add `PACK_BOOST_COST` to `worker/lib/coins.ts`**

Append to `worker/lib/coins.ts`:

```ts
export const PACK_BOOST_COST = 150;
```

- [ ] **Step 4: Wire boost + coins into the open handler**

In `worker/routes/collection.ts`, add `PACK_BOOST_COST` to the existing coins import:

```ts
import { DISCARD_VALUE, DISCARD_VALUE_SHINY, SHINY_CONVERSION_COST, PACK_BOOST_COST } from "../lib/coins";
```

Replace the body of `collection.post("/packs/:id/open", ...)` from the `generation` validation onward:

```ts
  const generation = Number((body as { generation?: unknown } | null)?.generation);
  if (!Number.isInteger(generation) || generation < 1 || generation > 9) {
    return c.json({ error: "Invalid generation" }, 400);
  }
  const boost = (body as { boost?: unknown } | null)?.boost === true;

  let coinsBalance: number | undefined = undefined;
  if (boost) {
    const coinsRow = await c.env.DB.prepare(
      "UPDATE users SET coins = coins - ? WHERE twitch_id = ? AND coins >= ? RETURNING coins"
    )
      .bind(PACK_BOOST_COST, user.twitchId, PACK_BOOST_COST)
      .first<{ coins: number }>();
    if (!coinsRow) return c.json({ error: "Not enough coins" }, 400);
    coinsBalance = coinsRow.coins;
  }

  const catalog = await c.env.DB.prepare(
    "SELECT id, rarity, category, sort_order AS sortOrder FROM cards WHERE generation = ?"
  )
    .bind(generation)
    .all<{
      id: string;
      rarity: Rarity;
      category: Category;
      sortOrder: number;
    }>();
  if (!catalog.results || catalog.results.length === 0) {
    return c.json({ error: "Catalog is empty" }, 500);
  }

  const picked = pickRandomCards(catalog.results, 10, pack.tier, boost);
```

Leave the `INSERT INTO pack_cards` / `INSERT INTO user_cards` / `UPDATE packs SET opened_at` batch and the `cardDetails` lookup unchanged. Change the final response:

```ts
  if (coinsBalance === undefined) {
    const userRow = await c.env.DB.prepare("SELECT coins FROM users WHERE twitch_id = ?")
      .bind(user.twitchId)
      .first<{ coins: number }>();
    coinsBalance = userRow?.coins ?? 0;
  }

  return c.json({ cards, coins: coinsBalance });
```

(`coinsBalance` is only assigned inside the `if (boost)` block, then falls back to a `SELECT` when boost was false — this avoids a second query on the boosted path, re-reading a value we already got from the `UPDATE ... RETURNING coins`, at the cost of one extra query on the far more common unboosted path — same cost `GET /collection` already pays.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --config vitest.workers.config.ts test/routes/collection.test.ts`
Expected: PASS, all tests in the file (including the pre-existing ones — they don't assert on `coins`' absence, so the new field is additive).

- [ ] **Step 6: Commit**

```bash
git add worker/lib/coins.ts worker/routes/collection.ts test/routes/collection.test.ts
git commit -m "feat: let viewers pay coins to boost a pack's odds on open"
```

---

### Task 3: Frontend — boost checkbox, coins spend, and header refresh

**Files:**
- Modify: `src/api.ts`
- Modify: `src/coins.ts`
- Modify: `src/collection.ts`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: `POST /api/collection/packs/:id/open` now returns `{ cards: CardView[]; coins: number }` and accepts `{ generation: number; boost?: boolean }` (Task 2).
- Produces: `openPack(packId: number, generation: number, boost?: boolean): Promise<{ cards: CardView[]; coins: number }>`.
- Produces: `src/coins.ts` exports `PACK_BOOST_COST = 150`.

No new automated test for this task: `openAlbumPickerModal`/`renderPendingPacks` build real DOM via `document.createElement` and there's no jsdom/DOM environment wired into `vitest.config.ts` (`environment: "node"`) — every existing `src/**/*.test.ts` file tests pure logic only, matching that constraint. Verify this task by running the dev server and exercising the modal manually (Step 4).

- [ ] **Step 1: Update `src/api.ts`**

Replace `openPack`:

```ts
export function openPack(packId: number, generation: number, boost: boolean = false): Promise<{ cards: CardView[]; coins: number }> {
  return request(`/collection/packs/${packId}/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ generation, boost }),
  });
}
```

- [ ] **Step 2: Add `PACK_BOOST_COST` to `src/coins.ts`**

Append to `src/coins.ts`:

```ts
export const PACK_BOOST_COST = 150;
```

- [ ] **Step 3: Wire the checkbox and boost flag through `src/collection.ts`**

Add the import at the top of `src/collection.ts`:

```ts
import { PACK_BOOST_COST } from "./coins";
```

Replace `openAlbumPickerModal`:

```ts
function openAlbumPickerModal(coins: number): Promise<{ generation: number; boost: boolean } | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const disabled = coins < PACK_BOOST_COST;
    overlay.innerHTML = `
      <div class="modal">
        <h3>¿De qué álbum quieres abrir el sobre?</h3>
        <div class="modal-gen-grid">
          ${GENERATIONS.map(
            (g) => `<button type="button" class="btn modal-gen-btn" data-gen="${g.id}">Gen ${g.id} · ${g.region}</button>`
          ).join("")}
        </div>
        <label class="modal-boost-toggle${disabled ? " disabled" : ""}">
          <input type="checkbox" id="modal-boost-checkbox" ${disabled ? "disabled" : ""} />
          Boostear odds (${PACK_BOOST_COST} 🪙)
        </label>
        <button type="button" class="btn modal-cancel-btn">Cancelar</button>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const genBtn = target.closest<HTMLElement>(".modal-gen-btn");
      if (genBtn) {
        const boost = (document.getElementById("modal-boost-checkbox") as HTMLInputElement).checked;
        overlay.remove();
        resolve({ generation: Number(genBtn.dataset.gen), boost });
        return;
      }
      if (target.closest(".modal-cancel-btn") || target === overlay) {
        overlay.remove();
        resolve(null);
      }
    });
  });
}
```

Update `renderPendingPacks`'s `onOpen` parameter type and its call site inside the click handler:

```ts
function renderPendingPacks(packs: PendingPack[], onOpen: (id: number, generation: number, boost: boolean) => Promise<void>): void {
```

```ts
    img.addEventListener("click", async () => {
      const choice = await openAlbumPickerModal(coins);
      if (choice === null) return;
      img.classList.add("opening");
      onOpen(pack.id, choice.generation, choice.boost).finally(() => {
        img.classList.remove("opening");
      });
    });
```

Update `load()`'s call to `renderPendingPacks` to pass `boost` through, spend coins, refresh the header, and surface the "not enough coins" race inline instead of crashing the pending-packs render:

```ts
  renderPendingPacks(data.pendingPacks, async (packId, generation, boost) => {
    clearCoinActionError();
    try {
      const result = await openPack(packId, generation, boost);
      coins = result.coins;
      document.dispatchEvent(new CustomEvent("coins-updated", { detail: { coins } }));
      await revealPack(packId, result.cards);
      await load();
    } catch (err) {
      showCoinActionError(err instanceof Error ? err.message : "Error al abrir el sobre");
    }
  });
```

`showCoinActionError`/`clearCoinActionError` already exist in this file (used by discard/convert-shiny) — no new function needed. Because `load()` is not re-called on the error path, the clicked pack's `img` keeps its `.opening` class only until the `finally` in the click handler removes it (the promise still resolves via the catch), and the pack stays in the pending list untouched — matching the spec's "pack sigue sin abrir, modal no se cierra" (the modal is already closed by this point since the choice was already made; the *pack* not being marked opened is what's preserved).

- [ ] **Step 4: Add `.modal-boost-toggle` styling and manually verify**

Add to `src/style.css`, after the existing `.modal-cancel-btn` rule:

```css
.modal-boost-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.9rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
  color: var(--text-em);
  justify-content: center;
}
.modal-boost-toggle.disabled {
  opacity: 0.5;
  cursor: not-allowed;
  color: var(--muted);
}
```

Run: `npm run dev`, log in as a viewer with a pending pack, click it, confirm:
- Checkbox reads "Boostear odds (150 🪙)".
- Checkbox is enabled/checked-able when coins ≥ 150, greyed out and unclickable when coins < 150.
- Opening with the box checked debits 150 coins from the header display; opening with it unchecked doesn't.
- Opening with insufficient coins (test by having < 150) never fires — box is disabled so this path is only reachable via a second tab race; skip live-verifying the race, Task 2's test already covers the 400 path server-side.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts src/coins.ts src/collection.ts src/style.css
git commit -m "feat: add pack odds boost checkbox to the album picker modal"
```

---

### Task 4: Visual feedback for a boosted pack opening

**Files:**
- Modify: `src/collection.ts`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: `choice.boost` from Task 3's click handler in `renderPendingPacks`.
- Produces: no new exports — purely a DOM/CSS addition scoped to the moment a pack is opening.

No automated test (visual-only DOM effect, same DOM-testing gap as Task 3). Verify manually in Step 3.

- [ ] **Step 1: Add the boost ribbon markup in `src/collection.ts`**

The click handler needs to append a ribbon into `hoverScale`, but today `hoverScale` is declared *after* the click handler is attached. Replace the entire `packs.forEach((pack, index) => { ... })` body in `renderPendingPacks` with:

```ts
  packs.forEach((pack, index) => {
    const img = document.createElement("img");
    img.className = "pack-open-img";
    img.src = "/pack.webp";
    img.alt = "Abrir sobre";
    const idleDelay = `-${(index * 0.7) % 2.4}s`;
    img.style.animationDelay = idleDelay;

    const wrapper = document.createElement("div");
    wrapper.className = shouldShowFoil(pack.tier) ? "pack-wrapper apoyo" : "pack-wrapper";
    wrapper.style.animationDelay = idleDelay;
    const hoverScale = document.createElement("div");
    hoverScale.className = "pack-hover-scale";
    const shine = document.createElement("div");
    shine.className = "pack-foil-shine";
    hoverScale.appendChild(img);
    hoverScale.appendChild(shine);
    if (shouldShowFoil(pack.tier)) {
      const corner = document.createElement("div");
      corner.className = "pack-apoyo-corner";
      const ribbon = document.createElement("div");
      ribbon.className = "pack-apoyo-ribbon";
      ribbon.textContent = "★";
      corner.appendChild(ribbon);
      hoverScale.appendChild(corner);
    }
    wrapper.appendChild(hoverScale);
    row.appendChild(wrapper);

    img.addEventListener("click", async () => {
      const choice = await openAlbumPickerModal(coins);
      if (choice === null) return;
      img.classList.add("opening");
      if (choice.boost) {
        const boostCorner = document.createElement("div");
        boostCorner.className = "pack-apoyo-corner pack-boost-corner";
        const boostRibbon = document.createElement("div");
        boostRibbon.className = "pack-apoyo-ribbon pack-boost-ribbon";
        boostRibbon.textContent = "⚡";
        boostCorner.appendChild(boostRibbon);
        hoverScale.appendChild(boostCorner);
      }
      onOpen(pack.id, choice.generation, choice.boost).finally(() => {
        img.classList.remove("opening");
      });
    });
  });
```

The only structural change from the current source is moving the `img.addEventListener("click", ...)` block to *after* `wrapper`/`hoverScale`/`shine`/corner-ribbon construction, so the click handler can close over `hoverScale`. Everything each block does is otherwise identical to today's code.

- [ ] **Step 2: Add `.pack-boost-*` styling in `src/style.css`**

Add after the existing `.pack-apoyo-ribbon` rule:

```css
.pack-boost-ribbon {
  background: var(--purple);
}
```

`.pack-boost-corner` needs no extra rule — it inherits `.pack-apoyo-corner`'s position/sizing, and the `⚡` ribbon text plus the purple background (vs. `--gold` for real apoyo ribbons) is what distinguishes it, per spec's "no confundirse con el tier apoyo real".

- [ ] **Step 3: Manually verify**

Run: `npm run dev`. With a pending pack, open the modal, check the boost box, confirm generation, and observe: at the moment the pack image starts its opening (fade to 50% opacity) animation, a purple "⚡" ribbon appears in the top-left corner — distinct from the gold "★" ribbon an `apoyo`-tier pack shows by default. Open an unboosted pack and confirm no ribbon appears (unless the pack is itself `apoyo` tier, in which case only the gold "★" shows, unchanged from today).

- [ ] **Step 4: Commit**

```bash
git add src/collection.ts src/style.css
git commit -m "feat: show a boost ribbon while a boosted pack is opening"
```

---

## Self-Review Notes

- **Spec coverage:** odds engine (Task 1), cost + endpoint + atomic debit + always-present `coins` in response (Task 2), frontend checkbox/modal/`api.ts`/`coins.ts`/coins-updated event/error handling (Task 3), boost visual during opening (Task 4). `admin.ts` untouched and no `packs` row persistence for boost — never introduced in any task, matching "out of scope."
- **Positional-argument bug from the spec review is fixed here**: `boost` is the 4th param of `pickRandomCards`, `random` is 5th — Task 1 updates every existing test call site accordingly, not just the new ones.
- **Type consistency:** `openPack`'s return type (`{ cards: CardView[]; coins: number }`, Task 3 Step 1) matches what Task 2's endpoint actually returns (`c.json({ cards, coins: coinsBalance })`). `renderPendingPacks`'s `onOpen` signature (`(id, generation, boost) => Promise<void>`) matches both its call site in `load()` and its invocation in the click handler across Tasks 3 and 4.
