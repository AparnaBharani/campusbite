# CampusBite

CampusBite is a campus-first food ordering and delivery application for the Amrita Ettimadai pilot. It replaces the original single-file interactive prototype with a small web application, server-enforced roles, durable order data, demand forecasting, and a campus map.

## What is implemented

- **Student sign-in:** passwordless, six-digit email code. Student addresses must match the exact configured domain (`cb.students.amrita.edu` by default); matching is enforced by the API, not only the sign-in form.
- **Provisioned operations roles:** canteen, rider, and admin roles are assigned from trusted server configuration. There is no client-side role switcher or role self-selection.
- **Separate role pages:** student storefront and order tracking, canteen order/menu desk, rider delivery queue, and campus operations dashboard.
- **Ordering:** a student can order available items from one canteen per order. Prices, canteen ownership, totals, and order status transitions are validated by the server.
- **Demand-based suggestions:** seasonal demand score using a 28-day order history, with stronger weights for the same weekday/hour and the latest seven days. Time buckets use `Asia/Kolkata`. Seeded sample history makes the pilot useful before live orders accumulate; actual orders are added to the history.
- **Campus map:** OpenStreetMap tiles via Leaflet, approximate campus pickup/drop-off markers, route preview, and a moving rider marker while an order is out for delivery. The rider marker is a demo simulation, not live GPS.
- **Caching and operations:** Redis menu cache (60 seconds), recommendation cache (5 minutes per student/time bucket), Redis OTP request limits by email and client IP, database indexes, health endpoints, and idempotent SQL migrations.

## Delivery stages

1. **Application foundation:** separated browser assets, server modules, SQL migrations, dependency lockfile, container image, and local Compose services.
2. **Identity and access:** exact student-domain validation, emailed one-time codes, hashed expiring challenges, persistent HTTP-only sessions, and server-provisioned roles/outlet assignments.
3. **Campus ordering:** live availability, single-canteen carts, server-calculated totals, durable orders, canteen status flow, and rider/admin assignment workflows.
4. **Recommendations and tracking:** 28-day weekday/hour demand signal in India time, per-student preference boost, cached forecasts, order status polling, and an OpenStreetMap campus route preview.
5. **Reliability and handoff:** Redis caching/rate limits, database indexes and migration locking, focused tests, Compose validation, security-advisory cleanup, and the setup/production checklist below.

## Run locally

```powershell
Copy-Item .env.example .env
$secret = node -p "require('node:crypto').randomBytes(32).toString('hex')"
(Get-Content .env) -replace '^SESSION_SECRET=.*$', "SESSION_SECRET=$secret" | Set-Content .env
docker compose up -d db cache mailpit
npm ci
npm start
```

This runs the app on Node 22 and PostgreSQL, Redis, and Mailpit in Docker. The database and Redis ports are published on `5433` and `6379`, so local PostgreSQL services on the default port don't conflict. Open:

- App: <http://localhost:3000>
- Local email inbox: <http://localhost:8025> (SMTP on `localhost:1025`)

Enter an address ending in `@cb.students.amrita.edu`, request a code, and read it in Mailpit. Mailpit is a local-only email catcher; no email is sent to the real address during this setup.

The sample `.env.example` provisions `admin@campus.demo`, `rider@campus.demo`, and one `@campus.demo` partner for each canteen. These are **local demo accounts only**; Mailpit catches their sign-in codes. Change them to individually approved addresses before any shared or production deployment.

To run the fully containerized version instead, build the app image and start all services:

```powershell
docker compose up --build
```

Use `npm run dev` instead of `npm start` for automatic server restarts during development. Never commit `.env`.

## Provisioning partner and operations accounts

Roles cannot be chosen by the user. Add approved addresses to the `ROLE_EMAILS` JSON value in `.env`, then restart the app:

```dotenv
ROLE_EMAILS={"admin":["ops@amrita.edu"],"rider":["rider.one@amrita.edu"],"canteen":{"MBA":["mba.partner@amrita.edu"],"IT":["it.partner@amrita.edu"],"MC":["mc.partner@amrita.edu"]}}
```

The listed addresses can sign in using email codes and are assigned the configured role on the server. Accounts omitted from this allowlist can only become students, and only if their email matches an allowed student domain. For a different institution, set `ALLOWED_STUDENT_DOMAINS` to a comma-separated list of exact domains.

## Development and verification

```powershell
npm test
npm run check
```

`docker compose up --build` applies numbered SQL files in `migrations/` using a PostgreSQL advisory lock, so app replicas do not race migrations. Add future schema changes as new, forward-only numbered migrations.

## Architecture

```text
Browser
  └── Express app (static UI + same-origin JSON API)
        ├── PostgreSQL: users/roles, expiring email challenges, sessions, menus, orders, demand history
        ├── Redis: shared short-lived menu/recommendation cache and OTP rate limits
        └── SMTP: sign-in code delivery (Mailpit locally)
Browser map ── OpenStreetMap tile service (no Google Maps key)
```

- `public/` contains the responsive UI and path-based role pages.
- `server/` contains authentication, authorization, order APIs, shared cache integration, locations, and the forecast.
- `migrations/` contains the PostgreSQL schema and pilot seed data.
- Sessions are opaque random tokens stored as HMAC hashes in PostgreSQL and sent only in `HttpOnly`, `SameSite=Strict` cookies (`Secure` in production).
- Every write requires a same-origin request header. Role and outlet checks happen in API middleware and SQL predicates.
- Health probes are available at `/health/live` and `/health/ready`.

## Scaling and production checklist

The app tier is stateless and can be replicated behind a TLS-terminating load balancer. All replicas must share PostgreSQL, Redis, the same strong `SESSION_SECRET`, role/domain configuration, and SMTP service. Redis is required by the app; cache entries are disposable and can be rebuilt from PostgreSQL. Tune `DATABASE_POOL_MAX` per replica and use a managed PostgreSQL service, a managed Redis deployment, a production email provider, backups, monitoring, and a connection pooler when the number of app replicas grows. The Compose database/cache passwords and session secret are **development-only**.

Before a public deployment:

1. Replace local credentials, set a randomly generated `SESSION_SECRET` of at least 32 characters, and configure `APP_ORIGIN` to the HTTPS app origin.
2. Set `NODE_ENV=production`, `TRUST_PROXY=true` only behind a trusted proxy, production database/Redis URLs, and authenticated SMTP credentials.
3. Confirm student email-domain ownership and individually verify the staff email allowlist.
4. Replace approximate campus coordinates with verified delivery points and agree rider privacy/consent rules.
5. Add payment-provider integration, audit/retention policy, alerting, and backup/restore drills before accepting real payments or relying on the service operationally.

## Pilot boundaries

This is a hackathon-ready application, not a production Swiggy service. It does not charge money, send a canteen notification, provide live device GPS, or integrate with an official university identity provider. Email codes prove access to an inbox but do not replace the university's SSO. Demo demand history is synthetic until real orders arrive. OpenStreetMap coverage/coordinates are approximate and the map route is illustrative. Configure email delivery, campus operations, privacy, and service monitoring before a real campus launch.

The original `swiggy_campus_connect_amrita_ettimadai.html` is retained as a prototype/reference; the application served by Compose is in `public/`.
