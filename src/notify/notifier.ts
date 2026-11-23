// Every notification channel sits behind this interface (spec: Schedule & notifications),
// so Telegram or ntfy can be added without touching the core.

import type { ShopOffer, ShopSnapshot } from "../shop.ts";

export interface Notifier {
  /** The daily shop; wishlist hits go out first, as their own message that pings the owner. */
  sendShop(snapshot: ShopSnapshot, wishlistHits: ShopOffer[]): Promise<void>;
  /** A text alert that pings the owner, such as "cookie dead". */
  sendAlert(text: string): Promise<void>;
}
