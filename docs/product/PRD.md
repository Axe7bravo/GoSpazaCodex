# GoSpaza — Product Requirements

## Product

GoSpaza is an on-demand grocery and alcohol delivery marketplace launching first in Bloemfontein, Free State, South Africa.

The platform has four primary actor surfaces:

- Customer
- Merchant / Picker
- Driver
- Platform Admin

## Marketplace model

GoSpaza supports many merchants platform-wide, but MVP commerce is strictly:

```text
1 cart = 1 merchant/store
1 order = 1 merchant/store
```

For MVP, one merchant maps to one physical store. Multi-branch merchant organisations are deferred.

Merchants manage their own products, prices, inventory and employees/pickers. Drivers can be merchant-affiliated or platform drivers.

## Customer commerce

Customers can order groceries, fresh produce and alcohol for ASAP or scheduled delivery.

Variable-weight repricing is not part of MVP. Weight-based goods use predefined variants such as 500 g, 1 kg and 2 kg.

Substitution preferences:

```text
BEST_MATCH
CONTACT_ME
DO_NOT_SUBSTITUTE
```

Until a higher-total payment strategy is verified with the payment provider, substitutions must not create an unpaid higher total.

## Payments

Yoco Hosted Checkout is the initial card-payment integration.

Browser return/redirect is not authoritative proof of payment. Backend/provider confirmation is authoritative.

The original 115% payment-buffer concept is not a hard requirement and must not be built into the architecture without verified provider support.

Customer store credit is preferred for many adjustment scenarios while original-payment refunds should remain supported where the provider permits them.

## Delivery

Dispatch is server-controlled and offer-based, not public first-come claiming.

Driver types:

```text
MERCHANT
PLATFORM
```

Merchant delivery modes:

```text
MERCHANT_ONLY
PLATFORM_ONLY
HYBRID
```

In HYBRID mode, merchant drivers are prioritised before platform spillover according to policy.

Normal grocery delivery uses a server-generated OTP. The customer sees the OTP at the appropriate delivery stage and provides it only when satisfied with the handoff. The driver submits it for server verification and must never be able to retrieve the valid OTP.

## Alcohol

The ordering customer must satisfy age-verification eligibility.

At delivery, the actual recipient must pass doorstep age/ID verification before OTP confirmation. A nominated alternate adult may receive the order but must present their own valid identification.

For MVP, a mixed grocery + alcohol order is all-or-nothing at handoff: failed alcohol verification prevents the whole order from being handed over.

## Merchant onboarding

Merchants self-apply. Platform staff review applications and later approve/provision merchants.

Merchant authentication identity is not equivalent to approved merchant tenancy.

## Marketplace economics

GoSpaza collects customer payment into the platform payment account.

Merchant payouts are calculated by the system but physically transferred manually by back-office staff.

Commission:
- global default;
- optional merchant override;
- effective-dated;
- calculated on commissionable merchandise rather than delivery fee.

Merchant settlement concept:

```text
gross merchandise sales
- merchant-funded discounts
- commission
- merchant-attributable refunds/chargebacks
± adjustments
= net merchant payable
```

Settlement states:

```text
DRAFT
READY_FOR_APPROVAL
APPROVED
PAID
RECONCILED
FAILED
```

Negative balances carry forward.

Driver compensation is separate from the customer delivery fee.

## Cancellation

Before merchant acceptance:
- customer self-service cancellation is allowed.

After merchant acceptance:
- cancellation becomes a request/support flow.

After pickup:
- ordinary cancellation is not available.

After delivery:
- refunds/returns/adjustments follow post-order processes.

## Launch constraints

- Initial city: Bloemfontein.
- Store stock/prices are maintained manually.
- No POS integrations in MVP.
- The launch location is configuration/data, not hard-coded business logic.
