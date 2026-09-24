---
name: medusa-first-architecture
description: Use when designing or implementing GoSpaza backend/auth/commerce architecture on Medusa v2. Prefer current Medusa-native primitives and first-party patterns before adding custom entities, modules, auth, workflows, links, or infrastructure.
---

# Medusa-First Architecture

Use this skill whenever a GoSpaza milestone touches Medusa backend architecture, authentication, commerce data, workflows, modules, module links, payments, fulfillment, inventory, store credit, or admin/user concepts.

## Core rule

Before creating a custom GoSpaza source of truth, determine whether the pinned Medusa version already owns the concern.

Prefer, in order:

1. Existing Medusa-native capability.
2. Medusa configuration.
3. Medusa workflow/module-link extension pattern.
4. A small GoSpaza custom module linked to native Medusa entities.
5. A fully custom source of truth only when 1–4 cannot satisfy the product requirement.

Never duplicate Medusa commerce state merely because a custom table seems easier.

## Evidence hierarchy

When deciding how to implement a Medusa concern:

1. Current milestone and `AGENTS.md` define GoSpaza product requirements and remain authoritative.
2. Inspect the exact installed/pinned Medusa package version and existing project configuration.
3. Consult current official Medusa documentation when available.
4. Consult official first-party Medusa examples for implementation patterns.
5. Use general framework knowledge only after the above.

Do not copy an example's business assumptions into GoSpaza.

## Relevant first-party references

### Marketplace / Vendors example

Useful for:
- custom actor types;
- vendor/merchant admin authentication patterns;
- custom modules;
- module links;
- workflows;
- vendor-scoped API patterns;
- product/order association patterns.

Do not copy:
- multi-vendor carts;
- order splitting by vendor;
- any assumption that one customer order contains multiple merchants.

GoSpaza invariant:

```text
1 cart = 1 merchant
1 order = 1 merchant
```

### Restaurant Marketplace example

Useful for:
- delivery module boundaries;
- driver entities;
- delivery workflow patterns;
- real-time delivery concepts;
- operational APIs.

Do not automatically copy:
- restaurant-specific models;
- its dispatch algorithm;
- its delivery state machine;
- assumptions that conflict with GoSpaza's merchant/platform hybrid driver model;
- verification behavior.

## Authentication guidance

Medusa has native authentication concepts and supports custom actor types.

For GoSpaza:

```text
customer      -> Medusa customer actor
platform user -> Medusa user actor
merchant      -> custom actor type
driver        -> custom actor type
```

Do not create a second authentication system.

Use Medusa auth providers/routes and authentication middleware unless the milestone explicitly establishes a justified custom provider.

Do not create merchant or driver business-domain entities early merely to make authentication convenient. Actor identity provisioning should occur with the milestone that owns the relevant domain entity unless the current milestone explicitly says otherwise.

## Native ownership reminders

Check Medusa first for:

```text
Customer
User
Product
ProductVariant
Price
InventoryItem
StockLocation
Cart
Order
Payment
Promotion
Fulfillment
Shipping Option
Service Zone foundations
Store Credit
Authentication
```

GoSpaza custom modules should generally represent marketplace-specific state such as:

```text
Merchant business data
Order operational state
Delivery / dispatch
Compliance
Marketplace finance
Configuration / audit
```

## Module links

When GoSpaza custom state relates to a Medusa-owned entity, prefer a supported module-link relationship where appropriate rather than copying Medusa fields into GoSpaza tables.

Before adding a link:
- verify the exact installed Medusa API/pattern;
- define ownership and cardinality clearly;
- consider deletion/archive behavior;
- ensure migrations/link sync are accounted for;
- do not create speculative links for future features.

## Workflows

Use Medusa workflows for important multi-step mutations when appropriate.

A workflow should own a coherent business mutation, not merely wrap CRUD for style.

Critical GoSpaza examples may later include:
- merchant approval/provisioning;
- order acceptance transitions;
- complete picking;
- dispatch assignment;
- complete delivery;
- refund/adjustment;
- settlement generation.

Use compensation behavior where a multi-step mutation can partially fail.

## Version discipline

Never assume a Medusa API from memory.

Before using an API with version-sensitive behavior:
- inspect the project's pinned package versions;
- inspect current types/source if needed;
- consult official docs/examples if available;
- implement against the pinned version.

Do not upgrade Medusa packages during a milestone unless the milestone explicitly requires an upgrade or a verified incompatibility blocks the milestone.

Keep core `@medusajs/*` package versions aligned unless official package constraints demonstrate otherwise.

## Scope discipline

A first-party example is a reference, not permission to import unrelated features.

Only copy/adapt code required for the current milestone.

Do not pre-build later marketplace features.

## Command policy

Follow the repository `AGENTS.md` command/quota policy.

Do not run installs, migrations, tests, builds, lint, typecheck, Docker, dev servers, or command-heavy verification unless the user explicitly requests it.

When runtime information is needed, give the user the minimal command and request the output.

## Required architecture note

Whenever the milestone introduces a custom entity/module adjacent to a Medusa-native concern, include a short note in the completion report:

```text
Medusa ownership decision:
- Native concern inspected:
- Why native/config/link was or was not sufficient:
- Custom state introduced:
- Source-of-truth boundary:
```

This is mandatory for architecture-sensitive milestones.
