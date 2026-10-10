# Inkline — Wear Your Creativity.

Production-grade foundation for a print-on-demand e-commerce business,
India-first. Original artwork printed on premium apparel, drinkware and
prints — made only after the customer orders.

## Stack

| Layer        | Choice                                                            |
| ------------ | ----------------------------------------------------------------- |
| Framework    | Next.js 16 (App Router, RSC-first)                                |
| Language     | TypeScript (strict mode)                                          |
| Styling      | Tailwind CSS v4 + design tokens                                   |
| UI           | Custom design system on Radix primitives (a11y-first)             |
| Database     | PostgreSQL via Drizzle ORM (migration-first, `drizzle-kit`)       |
| Validation   | Zod (API + forms + environment)                                   |
| Auth         | Prepared (edge `proxy.ts` gating seams + env groups)              |
| Payments     | Razorpay-ready env/service seams (India), Stripe-ready interface  |
| POD          | Supplier-agnostic service seam (`services/pod/`)                  |
| Testing      | Vitest + Testing Library                                          |

> **ORM note:** the data layer uses Drizzle ORM (the provisioned database
> toolkit for this project) with `drizzle-kit` migrations. The Prisma-style
> workflow the project plan calls for — schema file, typed client,
> migration files, push/inspect commands — maps 1:1; services are written
> so an ORM swap stays possible behind the service layer.

## Quick start

```bash
cp .env.example .env     # fill DATABASE_URL (and future secrets)
npm install
npx drizzle-kit push     # apply schema to your local Postgres
npm run dev              # http://localhost:3000
```

## Commands

| Command              | Purpose                                  |
| -------------------- | ---------------------------------------- |
| `npm run dev`        | Development server                       |
| `npm run build`      | Production build                         |
| `npm run start`      | Production server                        |
| `npm run lint`       | ESLint                                   |
| `npm run typecheck`  | Strict TS check                          |
| `npm run test`       | Unit/component test suite                |
| `npm run db:push`    | Apply schema to the database             |
| `npm run db:generate`| Generate a SQL migration from schema     |
| `npm run db:seed`    | Idempotent development seed data         |
| `npm run db:verify`  | Database integrity verification suite    |
| `npm run db:migrate` | Apply committed migrations from the journal |
| `npm run db:parity` | Verify SQL migration / Drizzle schema parity |
| `npm run db:verify-migrations` | Verify every on-disk migration is journaled |
| `npm run test:db`   | Run integration tests on disposable PostgreSQL |
| `npm run e2e:cart` | Exercise the guest cart HTTP lifecycle on disposable PostgreSQL |
| `npm run e2e:checkout` | Exercise checkout preparation and conflict recovery on disposable PostgreSQL |
| `npm run cart:maintenance` | Bounded cart abandonment / expiry cleanup |
| `npm run checkout:maintenance` | Expire checkout sessions, purge retained PII and prune idempotency keys |
| `npm run db:studio`  | Inspect the database in a browser        |

## Database

PostgreSQL via Drizzle ORM — 41 tables across 8 domains (users, catalog,
commerce, orders, POD, engagement, support, system) in
`src/db/schema/`. Conventions: UUID PKs, integer minor-unit money with
CHECK constraints, snake_case columns, snapshot semantics for orders,
supplier IDs stored separately from internal IDs, append-only POD event
log with idempotency keys. `npm run db:verify` asserts the contract
(uniques, checks, cascades, idempotency, rollback) without mutating data.

See `docs/ARCHITECTURE.md` for the module map, conventions and the
milestone seam points for auth, catalog, cart, payments and POD.

Further docs: `docs/SEARCH.md` (search, discovery and relevance),
`docs/RECOMMENDATIONS.md` (recommendation, personalization and discovery
intelligence), `docs/MANUAL-TESTING.md` (hands-on checklist for the catalog and
search engines), `docs/DESIGN_SYSTEM.md`, and
`services/catalog-service/README.md` (the Python intelligence service).

## Catalog browsing (Shop, Category, Collection)

`/shop`, `/category/[slug]` and `/collection/[slug]` are server-rendered from
`src/services/catalog/` (visibility rules in `visibility.ts`, queries in
`public-catalog.service.ts`, tagged caching in `cached.ts`, page loader in
`listing.service.ts`). The URL is the only filter/sort/page state; params are
parsed and validated in `src/lib/catalog/params.ts`. Every admin catalog write
expires the `catalog` cache tag (`invalidateCatalogCache`). Migration
`drizzle/0004_catalog_browsing.sql` adds the browsing indexes and slug-history
tables.

Public API: `GET /api/products`, `/api/categories`, `/api/collections`
(`{ data, pagination }`, rate limited, validated params).

## Persistent cart (Part 14)

Guest carts use a random HttpOnly, SameSite cookie; only its SHA-256 digest is
stored in `carts.session_id`. Signed-in carts are resolved from a fresh server
session. Cart mutations re-read catalog price, seller status and available
inventory in PostgreSQL transactions; callers send product/variant IDs and
quantity, never authoritative prices or totals. Writes require a JSON body,
Same-Origin checks and an `Idempotency-Key`; cart versions reject stale edits.

The migration `drizzle/0009_cart_wishlist_saved_items.sql` preserves the existing
cart tables, adds cart lifecycle/version snapshots, consolidates active-cart
duplicates before owner-unique indexes, and adds separate Save for Later and
idempotency tables. Wishlist rows remain separate. Part 15 adds checkout
preparation, but payment, order creation, inventory reservation, shipping quotes
and destination tax calculation remain unavailable; cart totals are current
catalog estimates and delivery is intentionally `null` until a real rating
service is connected.

| Endpoint | Contract |
| --- | --- |
| `GET /api/cart` | `{ ok: true, data: CartDTO }`; private/no-store, live reconciliation |
| `POST /api/cart/items` | `{ productId, variantId, quantity, source?, cartVersion?, recommendation? }` + `Idempotency-Key`; server validates and prices |
| `PATCH /api/cart/items/:itemId` | `{ quantity, cartVersion? }` + `Idempotency-Key` |
| `DELETE /api/cart/items/:itemId` | `{ cartVersion? }` + `Idempotency-Key` |
| `POST /api/cart/merge` | `{}`; explicitly merge the guest cart into the authenticated account |
| `POST /api/cart/items/:itemId/accept-price` | Explicitly accept the current server price |
| `POST /api/cart/items/:itemId/save-for-later` | Move the line to the separate saved-items list |
| `GET /api/cart/saved-items` | Live-priced Save for Later lines (not included in cart totals) |
| `POST /api/cart/saved-items/:savedItemId/restore` | Revalidate price and stock, then restore |
| `GET/POST/DELETE /api/wishlist` | Signed-in, product-scoped wishlist operations |
| `POST /api/wishlist/:itemId/move-to-cart` | Move a selected purchasable wishlist variant into the cart |

Successful APIs use the shared `{ ok: true, data }` envelope; errors use
`{ ok: false, error: { code, message } }`. Account identity and item ownership
are resolved on the server; IDs from another cart do not authorize access.

Run `npm run db:migrate` for committed migrations. Schedule
`npm run cart:maintenance -- --limit 500` as a single-instance server cron to
mark inactive carts abandoned, expire carts past configured TTL, and purge
expired carts / idempotency records in bounded batches. It does not send
marketing or abandonment emails.

### Database integration tests

The fast `npm test` suite skips DB integration tests unless `TEST_DATABASE_URL`
is configured. `npm run test:db` boots a disposable PostgreSQL cluster, applies
the schema and all committed migrations, runs the integration suite, and removes
the cluster afterwards. Run the Part 14 suite alone with:

```bash
npm run test:db -- -- npx vitest run tests/integration/cart-ecosystem.test.ts
npm run e2e:cart
```

The HTTP end-to-end command seeds disposable catalog data, starts a local Next.js
server, then checks same-origin rejection, guest cookies, add/retry, live totals,
quantity updates, Save for Later, restore, and remove before destroying the test
cluster. Integration fixtures use unique prefixes; all test data is discarded
with the disposable database.

## Customer profile, address book and checkout preparation (Part 15)

`/account/profile`, `/account/addresses`, and `/account/preferences` extend the
existing Auth.js user and account preferences. Profile updates only change the
name and unverified phone fields; email changes stay on the existing verified
email-change flow. Address-book CRUD is authenticated and owner-scoped. Address
writes serialize on the owning user row, use optimistic versions, keep at most
one default per shipping/billing role, and only return a duplicate hint—never
merge automatically. Format checks support international country codes and
India's state/PIN/mobile formats without claiming physical address verification.

| Endpoint | Contract |
| --- | --- |
| `GET /api/profile` | Current authenticated profile and optional completeness guidance; private/no-store |
| `PATCH /api/profile` | Same-origin, rate-limited `{ name?, phone? }`; cannot change email, role, credentials or verification |
| `GET /api/profile/preferences` | Current customer's shopping and communication preferences |
| `PATCH /api/profile/preferences` | Validated settings; marketing opt-in changes append consent history |
| `GET/POST /api/addresses` | Current owner's private address list / create; response reports a non-merging duplicate hint |
| `GET/PATCH/DELETE /api/addresses/:addressId` | Owner-scoped address read/update/delete; edits can use `expectedVersion` |
| `POST /api/addresses/:addressId/default` | Set default shipping or billing role transactionally |
| `POST /api/checkout/session` | Create/resume owner-scoped checkout using `Idempotency-Key`; validates the live cart |
| `GET /api/checkout/session/:id` | Revalidate and return the current private session summary |
| `PATCH /api/checkout/session/:id/contact` | Guest-only contact snapshot; accounts use their profile |
| `PATCH /api/checkout/session/:id/address` | Select owner-owned saved addresses or validated inline checkout snapshots |
| `GET /api/checkout/session/:id/delivery-options` | Returns only options from the server delivery provider |
| `PATCH /api/checkout/session/:id/delivery` | Select an option currently returned by the provider |
| `POST /api/checkout/session/:id/revalidate` | Versioned revalidation; cart-version changes require explicit review |
| `GET /api/checkout/session/:id/summary` | Live prices, inventory/cart warnings and non-final totals; private/no-store |
| `POST /api/checkout/session/:id/cancel` | Idempotent owner-scoped cancellation |

Mutations require same-origin JSON, rate limiting, fresh authenticated identity or
the existing HttpOnly guest-session cookie, version checks, and idempotency
keys where appropriate. Client prices, totals, sellers, stock, addresses and
state are never authoritative. Checkout stores private, versioned address and
contact snapshots; analytics/audit contain identifiers and non-PII issue codes
only. Guest data is not attached to an account by email; the guest cookie plus a
fresh authenticated session is required to claim a guest checkout.

Checkout is a preparation workflow, **not** an order or payment. Cart prices and
stock are re-read during validation. Totals use integer paise and the existing
catalog discount/tax estimate; estimates are labeled non-final. No delivery
provider or destination tax provider is currently wired, so there are no
shipping options, no authoritative destination tax amount, and `READY` remains
unavailable. The service contracts reject invented rates and fail closed until
real providers are integrated. Inventory is not reserved; no payment, order,
checkout completion or seller settlement is implemented.

Session expiry/PII retention are configured by
`CHECKOUT_SESSION_TTL_MINUTES` (default 45) and
`CHECKOUT_PII_RETENTION_DAYS` (default 30 after expiry/cancellation). Schedule
`npm run checkout:maintenance -- --limit 500` as a bounded single-instance cron;
it expires sessions, clears retained contact/address snapshots after the
configured window, prunes expired mutation keys, and keeps non-PII session rows
for aggregate reporting. `/admin/checkout` is under the existing DB-verified
admin route guard and exposes aggregates, issue codes and truncated session IDs,
not address/contact snapshots.

Run the Part 15 database integration suite with `npm run test:db` and its HTTP
flow with `npm run e2e:checkout`. The HTTP test intentionally expects
`NEEDS_ATTENTION` while shipping/tax are unconfigured, verifies that no made-up
method or total is returned, and exercises cart-version and price-change
recovery. Full READY-path, shipping, destination-tax and payment/order acceptance
must wait for those real integrations.

## Promotions and campaigns (Part 16)

`/admin/promotions` uses the existing catalog-editor role gate and promotion
services. The admin workspace creates and edits versioned rules, manages
campaign and promotion states, configures product/category/brand/seller/
collection/customer targets and schedules, simulates against current server
catalog quotes, and reports temporary reservation counts. Migration
`drizzle/0011_promotion_domain.sql` extends the existing coupon table, normalizes
coupon codes, backfills legacy coupon rows into the rule domain, and keeps legacy
free-shipping rows paused until shipping can be quoted authoritatively.

Discount amounts use integer minor units (paise in the configured India-first
storefront). Percentage rules use basis points and half-up rounding; line totals
are allocated by stable largest remainder so allocations sum exactly and never
exceed a line. Stackable rules apply sequentially; if an applicable exclusive
rule is present, only the best single discount is selected. Usage-limited rules
must use a coupon code. Capacity is reserved transactionally when a coupon is
applied to a checkout, serialized by promotion/coupon row locks, and released on
coupon removal, cancellation, revalidation failure or session expiry. A preview
or admin simulation never reserves usage.

| Endpoint | Contract |
| --- | --- |
| `GET/POST /api/admin/promotions` | List rules / create a validated draft |
| `PATCH /api/admin/promotions/:id` | Version-checked configuration update |
| `POST /api/admin/promotions/:id/state` | Version-checked activate, pause or archive |
| `GET /api/admin/promotions/analytics` | Reservation, release and not-yet-finalized redemption counts |
| `POST /api/admin/promotions/simulate` | Read-only simulation using current server catalog prices |
| `GET/POST /api/admin/campaigns` | List campaigns / create a draft campaign |
| `PATCH /api/admin/campaigns/:id` | Version-checked campaign update |
| `POST /api/admin/campaigns/:id/state` | Version-checked campaign lifecycle transition |
| `POST /api/promotions/preview` | Rate-limited, non-reserving coupon preview for the current cart |
| `POST/DELETE /api/checkout/session/:id/coupon` | Apply a coupon with an idempotency key / remove it and release its reservation |

Promotion and campaign writes create version snapshots and transactional
outbox/audit events; coupon codes are not copied into audit metadata. Coupon
lookup errors are deliberately generic, and the public preview returns no
capacity reservation. Abandoned or cancelled checkouts are not completed
redemptions: this repository has no trusted order/payment completion hook, so
`REDEEMED` counts and coupon usage increments are not finalized here.

Supported cart strategies are percentage off, fixed amount off, cart threshold,
quantity tiers, Buy X Get Y and bundle discounts, with bounded typed eligibility
and normalized catalog/customer targets. First-order/history, segments,
location, shipping-method and payment-method conditions are unavailable. Free
shipping cannot be activated until an authoritative shipping quote is wired;
`applyToCatalog` is rejected because product-detail price rendering still uses
the separate existing catalog-price-rule path. Checkout also remains blocked
until real shipping and destination-tax providers are configured. As in Part 15,
the server re-prices during checkout validation and observed cart changes block
progress until review/reapplication. A catalog change after the price read but
before the snapshot is persisted can still race: there is no cross-domain
catalog-version lock or payment-time finalization.
