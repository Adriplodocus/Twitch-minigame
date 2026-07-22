const BASE = "/api";

export type Rarity = "common" | "rare" | "epic" | "legendary";

export interface CardView {
  id: string;
  name: string;
  rarity: Rarity;
  imagePath: string;
  quantity: number;
  generation: number;
  sortOrder?: number;
  acquiredAt?: string | null;
  isNew?: boolean;
}

export interface PendingPack {
  id: number;
  createdAt: string;
  tier: "gratis" | "apoyo";
}

export interface CollectionResponse {
  cards: CardView[];
  pendingPacks: PendingPack[];
  coins: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include", ...init });
  if (res.status === 401) {
    window.location.href = "/";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // Response body wasn't JSON (or was empty) — fall back to the generic status message.
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export function getCollection(): Promise<CollectionResponse> {
  return request("/collection");
}

export function logout(): Promise<{ ok: boolean }> {
  return request("/auth/logout", { method: "POST" });
}

export function getMe(): Promise<{ ok: boolean; username: string; avatarUrl: string | null; coins: number }> {
  return request("/auth/me");
}

export function openPack(packId: number, generation: number, boost: boolean = false): Promise<{ cards: CardView[]; coins: number }> {
  return request(`/collection/packs/${packId}/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ generation, boost }),
  });
}

export function broadcastPack(packId: number): Promise<{ ok: true }> {
  return request(`/collection/packs/${packId}/broadcast`, { method: "POST" });
}

export function discardCard(cardId: string, quantity: number): Promise<{ ok: true; coins: number }> {
  return request("/collection/discard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardId, quantity }),
  });
}

export function convertToShiny(cardId: string): Promise<{ ok: true; coins: number }> {
  return request("/collection/convert-shiny", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardId }),
  });
}

export function getUserCollection(username: string): Promise<{ username: string; cards: CardView[] }> {
  return request(`/trade/users/${encodeURIComponent(username)}`);
}

export interface TradeOfferItem {
  side: "from" | "to";
  cardId: string;
  name: string;
  rarity: Rarity;
  imagePath: string;
  quantity: number;
}

export interface TradeOfferSummary {
  id: number;
  status: string;
  autoExpired: boolean;
  toUser?: string;
  fromUser?: string;
  items: TradeOfferItem[];
}

export function listOffers(): Promise<{ sent: TradeOfferSummary[]; received: TradeOfferSummary[] }> {
  return request("/trade/offers");
}

export function createOffer(input: {
  toUsername: string;
  offerCards: { cardId: string; quantity: number }[];
  requestCards: { cardId: string; quantity: number }[];
}): Promise<{ id: number; status: string }> {
  return request("/trade/offers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function acceptOffer(id: number): Promise<{ status: string }> {
  return request(`/trade/offers/${id}/accept`, { method: "POST" });
}

export function declineOffer(id: number): Promise<{ status: string }> {
  return request(`/trade/offers/${id}/decline`, { method: "POST" });
}

export function cancelOffer(id: number): Promise<{ status: string }> {
  return request(`/trade/offers/${id}/cancel`, { method: "POST" });
}

export function deleteOffer(id: number, side: "sent" | "received"): Promise<{ ok: boolean }> {
  return request(`/trade/offers/${id}?side=${side}`, { method: "DELETE" });
}

export function getPendingOfferCount(): Promise<{ count: number }> {
  return request("/trade/offers/pending-count");
}

export function getDailyPackStatus(): Promise<{ claimed: boolean; streak: number }> {
  return request("/daily-pack/status");
}

export function claimDailyPack(): Promise<{ ok: true; streak: number; milestone: boolean }> {
  return request("/daily-pack/claim", { method: "POST" });
}

export interface NotificationView {
  id: number;
  message: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export function getUnreadNotifications(): Promise<{ unread: boolean }> {
  return request("/notifications/unread");
}

export function listNotifications(): Promise<{ notifications: NotificationView[] }> {
  return request("/notifications");
}

export interface MarketplaceCardView {
  cardId: string;
  name: string;
  rarity: Rarity;
  imagePath: string;
  quantity: number;
  viewerQuantity: number;
}

export interface MarketplaceOfferSummary {
  id: number;
  creatorUsername: string;
  createdAt: string;
  demand: { cardId: string; name: string; rarity: Rarity; imagePath: string; viewerQuantity: number };
  offerItems: MarketplaceCardView[];
}

export interface MyMarketplaceOffer {
  id: number;
  status: "active" | "accepted";
  createdAt: string;
  acceptedAt: string | null;
  demand: { cardId: string; name: string; rarity: Rarity; imagePath: string };
  offerItems: { cardId: string; name: string; rarity: Rarity; imagePath: string; quantity: number }[];
}

export function listMarketplaceOffers(params: {
  page: number;
  demandQuery?: string;
  offerQuery?: string;
}): Promise<{ offers: MarketplaceOfferSummary[]; totalCount: number; page: number; pageSize: number }> {
  const q = new URLSearchParams({ page: String(params.page) });
  if (params.demandQuery) q.set("demandQuery", params.demandQuery);
  if (params.offerQuery) q.set("offerQuery", params.offerQuery);
  return request(`/marketplace/offers?${q.toString()}`);
}

export function listMyMarketplaceOffers(): Promise<{ offers: MyMarketplaceOffer[] }> {
  return request("/marketplace/offers/mine");
}

export function createMarketplaceOffer(input: {
  demandCardId: string;
  offerItems: { cardId: string; quantity: number }[];
}): Promise<{ id: number; status: string }> {
  return request("/marketplace/offers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function acceptMarketplaceOffer(id: number): Promise<{ status: string }> {
  return request(`/marketplace/offers/${id}/accept`, { method: "POST" });
}

export function cancelMarketplaceOffer(id: number): Promise<{ ok: boolean }> {
  return request(`/marketplace/offers/${id}/cancel`, { method: "POST" });
}

export function deleteMarketplaceOffer(id: number): Promise<{ ok: boolean }> {
  return request(`/marketplace/offers/${id}`, { method: "DELETE" });
}
