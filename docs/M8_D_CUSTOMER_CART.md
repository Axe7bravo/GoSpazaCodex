# M8-D Customer Cart

M8-D adds the authenticated customer cart presentation without changing the M8-B/M8-C cart ownership or mutation rules.

## Browser state

The customer app restores the authoritative cart from `GET /store/gospaza/cart` on mount and on foreground refresh. It does not persist cart, merchant, store, channel, customer, location or context authority in browser storage. Mutation responses return a cart ID, which is used only as a restoration hint for the authenticated current-cart endpoint.

## Store switch

A cross-store add preserves the backend's `CART_MERCHANT_CONFLICT` response. The UI keeps the current cart unless the customer explicitly chooses **Start new cart for this store**. Confirmation invokes the M8-C switch route with the selected variant, quantity, current location and `confirm: true`. Merchant and store ownership remain server-derived.

## Eligibility and recovery

Add and increase include the current M7 location so the backend can revalidate M6 eligibility. Decrease and removal omit location and remain available for stale carts. An uncertain mutation does not update local cart state; the UI tells the customer to reload the authoritative cart before trying another change.

## Presentation boundary

Cart money stays in integer minor units through the API and is formatted as ZAR only in the customer component. Cart media comes from the existing M5 tracked-public-image allowlist. The cart UI deliberately excludes checkout, delivery, shipping and payment controls.
