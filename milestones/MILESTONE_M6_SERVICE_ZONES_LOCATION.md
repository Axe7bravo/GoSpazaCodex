# GoSpaza — Milestone M6
## Service Zones & Customer Location

Implement **Milestone M6 only**.

This milestone is intentionally narrower than M5. Use the repository skills for shared rules instead of re-reading or re-implementing earlier milestone behavior.

Use:
- `gospaza-milestone-implementer`
- `medusa-first-architecture`
- `gospaza-security-review`

Do not run command-heavy verification. The user will run commands.

---

# 1. Objective

Establish the geographic foundation used later by customer discovery, delivery pricing, scheduling, checkout and dispatch.

M6 adds:

- platform-managed delivery/service zones;
- merchant-store assignment to service zones;
- customer saved addresses using Medusa-native customer address data;
- a GoSpaza location extension containing coordinates only;
- serviceability checks for a customer location;
- the Medusa-native fulfillment/service-zone topology needed by later delivery milestones, where confirmed by Medusa 2.18.0;
- admin service-zone management;
- customer address/location UI.

M6 does **not** implement store discovery, cart, shipping-option selection, scheduling, checkout, delivery orders or dispatch.

---

# 2. Pinned Medusa review — do this first

Inspect the installed **Medusa 2.18.0** APIs and core flows before editing.

Confirm the pinned behavior of:

- Fulfillment Module;
- Fulfillment Sets;
- native Service Zones;
- Stock Location ↔ Fulfillment Set links;
- Service Zone creation/update/delete workflows;
- Geo Zones supported by native Medusa Service Zones;
- customer address creation/update/delete APIs or workflows;
- module links needed for this topology.

Do not assume newer Medusa APIs.

If native Medusa Service Zones cannot represent arbitrary delivery polygons, **do not force them to**. GoSpaza's custom zone geometry remains the geographic source of truth, while Medusa-native service zones are commerce infrastructure for later shipping options.

If the pinned version materially prevents the topology below, stop and report the exact discrepancy before improvising.

---

# 3. Geographic ownership model

## 3.1 GoSpaza ServiceZone

Add the smallest custom marketplace model required for geographic policy.

Conceptually:

```text
ServiceZone
  id
  name
  active
  geometry
  delivery_fee_minor
  currency_code = "zar"
  created_at
  updated_at
```

Requirements:

- `geometry` represents a validated GeoJSON `Polygon` or `MultiPolygon`.
- coordinates use standard longitude/latitude ordering.
- server validates geometry before persistence.
- delivery fee is an integer minor-unit amount.
- no negative delivery fee.
- currency is ZAR for MVP.
- no category/store-specific delivery fee overrides in M6.

The custom ServiceZone is authoritative for geographic point-in-zone eligibility.

Do not duplicate Medusa-native Service Zone fields unnecessarily.

## 3.2 MerchantStore ↔ ServiceZone

A merchant store may serve multiple GoSpaza zones and a zone may contain multiple merchant stores.

Use a custom mapping such as:

```text
MerchantStoreServiceZone
  merchant_store
  service_zone
  active
  medusa_service_zone_id   // if native topology requires one per store-zone mapping
```

Required uniqueness:

```text
merchant_store + service_zone
```

A mapping being inactive must make that store ineligible for that zone.

Do not infer coverage from merchant address, stock-location address, or distance alone.

## 3.3 Customer address coordinates

Keep textual customer address data in Medusa-native customer addresses.

Add only a location extension such as:

```text
CustomerAddressLocation
  medusa_customer_address_id
  latitude
  longitude
  source
  updated_at
```

Required invariant:

```text
one Medusa customer address -> at most one location extension
```

Do **not** duplicate:

- address line 1;
- address line 2;
- city;
- province;
- postal code;
- phone;
- recipient name.

The custom extension exists only because Medusa's address model is not the geographic eligibility authority.

---

# 4. Geospatial engine

For M6, prefer a simple encapsulated server-side geometry service using validated GeoJSON and deterministic point-in-polygon evaluation.

Do **not** introduce PostGIS merely for M6 unless the repository/database already supports it cleanly.

The geometry implementation must be hidden behind a small service/interface so a later PostGIS migration is possible without changing API contracts.

Requirements:

- support Polygon;
- support MultiPolygon;
- boundary points must have deterministic behavior;
- reject malformed coordinates;
- reject latitude outside `[-90, 90]`;
- reject longitude outside `[-180, 180]`;
- do not trust a browser-provided zone ID;
- server computes zone membership from coordinates.

Avoid external geocoding infrastructure in M6.

---

# 5. Native fulfillment topology

M5 already provisions:

```text
MerchantStore -> Medusa Stock Location
Merchant -> Sales Channel
```

M6 should add the minimum native fulfillment structure required for future shipping options.

Expected shape, **if confirmed by Medusa 2.18.0**:

```text
MerchantStore
  -> Medusa Stock Location
       -> Medusa Fulfillment Set
            -> native Medusa Service Zone(s)
```

For a GoSpaza store-zone assignment:

```text
MerchantStoreServiceZone
  -> corresponding native Medusa Service Zone
```

Important:

- GoSpaza polygon geometry remains the geographic eligibility source of truth.
- Native Medusa Service Zone is a commerce/fulfillment hook, not the authorization boundary.
- Do not create shipping options in M6.
- Do not calculate checkout shipping in M6.
- do not create one native Medusa `Store` per merchant.

## Provisioning

Create one reusable, idempotent fulfillment provisioning path that supports:

```text
existing M5 merchant stores
future merchant approvals
new store-zone assignments
```

Do not create infrastructure from a read-only GET.

If a store already has the expected native fulfillment resources, reuse them.

---

# 6. Customer location acquisition

Do not add a paid geocoding provider in M6.

For MVP M6:

- customer enters the normal delivery-address text fields;
- customer may use browser Geolocation to attach coordinates;
- coordinates are sent to the backend and stored only after validation;
- serviceability is always recomputed server-side.

Do not treat browser coordinates as proof of physical presence or identity.

Do not silently geocode typed text through an external provider.

Keep the frontend/location abstraction clean enough that a map pin/geocoding provider can be added later without changing stored address contracts.

---

# 7. Serviceability rules

Given:

```text
latitude
longitude
```

server should determine:

```text
matching active GoSpaza ServiceZone(s)
active MerchantStoreServiceZone mappings
active merchant/store state
```

Return a minimal serviceability result.

Conceptually:

```json
{
  "serviceable": true,
  "eligible_store_count": 2,
  "zone_ids": ["..."]
}
```

Do not return full merchant/store discovery data in M6.

M7 owns store discovery and the single-store / multi-store customer experience.

## Overlapping zones

Overlapping service zones are allowed.

For M6:

- a point may match multiple zones;
- a store mapped to multiple matching zones counts once;
- serviceability is true if at least one active store mapping is eligible;
- do not yet choose a checkout delivery fee when multiple zones match.

Fee selection/checkout behavior belongs to later milestones.

---

# 8. Admin APIs

Add only M6 admin routes required for service-zone management.

Conceptually:

```text
GET    /admin/gospaza/service-zones
POST   /admin/gospaza/service-zones
GET    /admin/gospaza/service-zones/:id
PATCH  /admin/gospaza/service-zones/:id
POST   /admin/gospaza/service-zones/:id/stores
DELETE /admin/gospaza/service-zones/:id/stores/:merchantStoreId
```

Exact route shape should follow current repository conventions.

Admin must be a native authenticated platform user.

Validate all DTOs server-side.

Do not expose native Medusa fulfillment IDs unless operationally necessary.

---

# 9. Customer APIs

Add minimal customer routes.

Conceptually:

```text
GET    /store/gospaza/addresses
POST   /store/gospaza/addresses
PATCH  /store/gospaza/addresses/:id
DELETE /store/gospaza/addresses/:id

POST   /store/gospaza/serviceability
```

Use native Medusa customer address ownership.

A customer may only read or mutate their own addresses.

Never authorize address access from a client-supplied customer ID.

For serviceability, accepting anonymous coordinates is allowed if useful for future location gating, but it must return only the minimal eligibility summary and no private merchant data.

---

# 10. UI

## Admin

Implement/extend:

```text
/admin/service-zones
```

Provide:

- zone list;
- active/inactive state;
- delivery fee;
- geometry editor/input appropriate to the current admin UI;
- assigned merchant stores;
- create/edit;
- assign/unassign stores;
- loading/error/empty states.

Do not build a sophisticated GIS editor in M6.

A validated GeoJSON input/editor or similarly bounded MVP control is acceptable if no map tooling already exists.

## Customer

Implement:

```text
/account/addresses
```

Provide:

- native address fields;
- saved addresses;
- create/edit/delete;
- “Use current location” using browser Geolocation;
- serviceability result;
- clear permission-denied/unavailable-location states.

Do not implement customer store discovery here.

---

# 11. Security and integrity

Required protections:

- only platform admin can mutate service zones;
- merchant users cannot create or edit platform service zones;
- customer cannot access another customer's address by known ID;
- customer cannot submit a merchant/store ID to force eligibility;
- customer cannot submit a zone ID to force eligibility;
- client-supplied coordinates are range-validated;
- geometry is validated server-side;
- inactive zones do not provide serviceability;
- inactive store-zone mappings do not provide serviceability;
- inactive merchants/stores do not count as eligible;
- native fulfillment IDs are not authorization boundaries;
- all infrastructure provisioning is idempotent;
- deletion/deactivation must not strand inconsistent native mappings.

Prefer deactivation over destructive deletion when native fulfillment resources may later be referenced.

---

# 12. Capabilities

Do not create merchant service-zone management in M6.

Platform admins own service-zone configuration.

No new merchant RBAC capability is required unless implementation proves one is necessary for a read-only merchant view. Prefer no new merchant capability in M6.

---

# 13. Tests

Keep tests focused.

## Unit

Cover:

- point inside Polygon;
- outside Polygon;
- boundary behavior;
- MultiPolygon;
- malformed geometry;
- coordinate range validation;
- delivery fee validation.

## Real database / integration

Cover:

- service-zone persistence;
- store-zone mapping uniqueness;
- idempotent native fulfillment provisioning;
- repeated backfill does not duplicate resources;
- customer address ownership;
- cross-customer known-ID rejection;
- inactive zone excluded;
- inactive mapping excluded;
- inactive merchant/store excluded;
- overlapping zones do not duplicate eligible store count.

## Regression

Preserve M1-M5 tests.

Do not rewrite unrelated catalogue/inventory tests.

## Browser

Add focused coverage for:

- admin creates/edits a zone and assigns a store;
- customer creates an address with coordinates;
- customer sees serviceable result;
- customer sees non-serviceable result;
- geolocation permission/error state;
- another customer's address cannot be accessed through UI/API coverage as appropriate.

---

# 14. Backfill

M6 may need to provision native fulfillment resources for existing M5 merchant stores.

Provide an idempotent backfill command only if required.

If added, it should reuse the same application service/workflow used for future provisioning.

Running it twice must not create duplicate Fulfillment Sets or native Service Zones.

---

# 15. Explicitly out of scope

Do NOT implement:

- M7 store discovery;
- store cards/search;
- single-store customer UI;
- product discovery;
- cart;
- shipping-option selection;
- checkout;
- scheduling;
- Yoco;
- order creation;
- merchant acceptance;
- picking;
- substitutions;
- driver onboarding;
- dispatch;
- live tracking;
- OTP;
- alcohol delivery verification;
- refunds;
- finance;
- settlements;
- notifications;
- production map/geocoder integration;
- route-distance calculation;
- dynamic delivery-fee selection between overlapping zones.

---

# 16. Command policy

Do not execute:

- installs;
- migrations;
- Docker;
- lint;
- typecheck;
- tests;
- builds;
- dev servers.

If runtime evidence is genuinely required, give the user one exact single-line PowerShell command and wait for the result.

---

# 17. Completion report

When M6 implementation is complete, stop and return:

```text
MILESTONE M6 COMPLETE

1. Implemented
2. Medusa fulfillment decisions
3. Geographic ownership model
4. Native fulfillment provisioning
5. Customer addresses/location
6. Serviceability behavior
7. Admin service-zone management
8. Schema / module links / migrations
9. API routes / workflows
10. UI
11. Authorization / security
12. Tests added
13. Verification status
14. Commands for user to run
15. Explicitly NOT implemented
16. Known limitations
17. Files/modules materially changed
```

For verification commands:
- list them in strict order;
- make every PowerShell command one line;
- state where to stop on failure.

Stop after M6.
