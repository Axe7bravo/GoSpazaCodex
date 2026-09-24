# GoSpaza — UX Specification

## Visual direction

GoSpaza uses a warm neighbourhood-utility visual system:

- warm off-white / cream surfaces;
- strong charcoal / black typography;
- orange for primary action and movement;
- green for success and availability;
- product photography for retail personality;
- moderate rounding;
- clean premium layouts;
- route/journey-line and retail price-label motifs where appropriate.

Do not redesign the approved GoSpaza logo unless explicitly requested.

## Responsive strategy

Customer: mobile-first, fully responsive. Desktop must be purpose-built rather than stretched mobile.

Merchant: desktop/tablet-first. Picker flows must work strongly on tablet/mobile.

Driver: mobile-first with one dominant operational action per state.

Admin: desktop-first with dense operational tables, filters, queues and split views.

## Customer marketplace shape

The customer home derives from eligible merchants for the selected address/service zone:

```text
0 eligible merchants -> no-service state
1 eligible merchant  -> focused single-store experience
2+ merchants         -> marketplace discovery
```

Do not show misleading multi-store sections when only one store is available.

## Customer routes

```text
/
 /stores
 /stores/[storeId]
 /products/[productId]
 /search
 /cart
 /checkout
 /checkout/schedule
 /checkout/payment
 /orders
 /orders/[id]
 /orders/[id]/substitution/[requestId]
 /orders/[id]/delivery
 /wallet
 /account
 /account/addresses
 /account/age-verification
 /support
 /login
 /register
 /forgot-password
 /reset-password
 /verify-email
```

## Merchant routes

```text
/merchant
/merchant/orders
/merchant/orders/[id]
/merchant/orders/[id]/pick
/merchant/products
/merchant/products/new
/merchant/products/[id]
/merchant/inventory
/merchant/team
/merchant/delivery
/merchant/settlements
/merchant/settlements/[id]
/merchant/settings
```

## Driver routes

```text
/driver
/driver/offers/[id]
/driver/deliveries/[id]
/driver/deliveries/[id]/pickup
/driver/deliveries/[id]/navigate
/driver/deliveries/[id]/verify
/driver/deliveries/[id]/failed
/driver/earnings
/driver/history
/driver/profile
```

## Admin routes

```text
/admin
/admin/orders
/admin/dispatch
/admin/merchants
/admin/merchant-applications
/admin/merchant-applications/[id]
/admin/drivers
/admin/service-zones
/admin/settlements
/admin/settlements/[id]
/admin/refunds
/admin/commissions
/admin/settings
/admin/audit
/admin/reports
```

## Key customer interactions

- Cross-store add must show a deliberate keep-current-cart / clear-and-switch decision.
- Reorder rebuilds using current products, price and inventory; it does not blindly clone a historical cart.
- Substitution requests show original item, replacement, price effect, response deadline and fallback.
- OTP is server-generated and never exposed to the driver.
- Tracking must work with realtime updates plus polling/revalidation fallback.
- Customer cancellation actions are derived from backend state/capabilities.

## Key merchant/picker interactions

- Merchant dashboard is attention-first.
- Merchant can accept/reject orders with reasons.
- One active picker per order in MVP.
- Picking lines progress through explicit states.
- Picker can continue while a CONTACT_ME substitution waits.
- Picking completes only when every line is resolved.
- Completed picks become locked for normal editing.

## Driver interaction sequence

```text
ACCEPTED
TO_STORE
ARRIVED_AT_STORE
PICKED_UP
EN_ROUTE
ARRIVED_AT_CUSTOMER
VERIFICATION_REQUIRED
DELIVERED
```

Alcohol adds recipient age/ID verification before OTP.

## Admin interaction principles

- No generic status dropdown that bypasses business rules.
- High-risk overrides require controlled workflows.
- Admin finance must distinguish GMV, platform revenue, merchant sales, delivery fees and driver earnings.
- Sensitive actions are auditable.
