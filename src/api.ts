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
}

export interface PendingPack {
  id: number;
  createdAt: string;
  tier: "gratis" | "apoyo";
}

export interface CollectionResponse {
  cards: CardView[];
  pendingPacks: PendingPack[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include", ...init });
  if (res.status === 401) {
    window.location.href = "/";
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export function getCollection(): Promise<CollectionResponse> {
  return request("/collection");
}

export function logout(): Promise<{ ok: boolean }> {
  return request("/auth/logout", { method: "POST" });
}

export function getMe(): Promise<{ ok: boolean; username: string; avatarUrl: string | null }> {
  return request("/auth/me");
}

export function openPack(packId: number, generation: number): Promise<{ cards: CardView[] }> {
  return request(`/collection/packs/${packId}/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ generation }),
  });
}

export function broadcastPack(packId: number): Promise<{ ok: true }> {
  return request(`/collection/packs/${packId}/broadcast`, { method: "POST" });
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
