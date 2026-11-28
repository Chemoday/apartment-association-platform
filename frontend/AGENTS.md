# Engineering & Code Quality Rules (`AGENTS.md`)

This document defines mandatory engineering invariants for contributors and AI agents working on `Apartment-association-platform-frontend`. Every rule below exists to prevent real production bugs caught in prior CTO audits.

---

## 1. Security, Privacy & Fail-Closed Invariants

1. **Fail-Closed by Default**
   - Every access predicate (`canAccessRoute`, `hasSharedAccess`, `canAccessDocuments`, `canAccessIssues`, `canAccessChat`, `isObjectInTarget`) MUST return `false` when session state is missing (`me === null`), when `apartment_kind` is an unknown non-empty value, or when `target_scope` is unknown.
   - Never default `sharedAccess` to `true` when `me` is not yet loaded.
   - Security tests (`src/router/security.test.ts`) MUST test the real `useSessionStore()` in `me: null` and `shared_access: undefined` states, not only hand-crafted plain objects.

2. **Safe URLs & Zero `v-html`**
   - `vue/no-v-html` is an ESLint error. Render dynamic SVG/HTML declaratively with Vue bindings (`<svg><path :d="..." /></svg>`).
   - Never bind an API-supplied or user-supplied string directly to `:href`.
     - External links (`custom_url`, etc.) MUST pass through `safeHttpUrl()` (allowing only `http:` / `https:`).
     - Phone links MUST pass through `safeTelHref()` (strict E.164 `/^\+[1-9]\d{6,14}$/`).

3. **One-Time Secrets & PII Hygiene**
   - One-time tokens/codes in URL fragments (`#token`, `#code=...`) MUST be extracted and stripped in `createAuthGuard` (`src/router/access.ts`) before route components mount, stored only in volatile module memory (never `localStorage`, `sessionStorage`, or telemetry).
   - `scrollBehavior` (`src/router/index.ts`) MUST validate `to.hash` as a safe CSS ID selector (`/^[#][A-Za-z][\w-]*$/`) before passing it to `{ el: to.hash }`.
   - Join-request PII (`full_name`, `phone`, `email`) and bulk invitation lists MUST never be cached in browser storage or logged to telemetry.

---

## 2. API Contract & Mock Parity

1. **Single Source of Truth (`docs/API.md` & `docs/openapi.json`)**
   - Always check exact response/error shapes in `docs/API.md` and `docs/openapi.json` before implementing endpoints or views.
   - FastAPI / backend `422 VALIDATION_ERROR` responses use `ErrorResponse.errors` (mapped to `err.fieldErrors` by `src/api/client.ts`), NOT `payload.detail`. Always read `err.fieldErrors ?? err.payload?.errors`.
   - Handle `413 FILE_TOO_LARGE`, `429 RATE_LIMITED` (with `retry_after_seconds`), and `404 NOT_FOUND` (demo mode) explicitly where documented.
   - Keep `src/api/schema.d.ts` synchronized (`npm run check:openapi` must pass 100%).

2. **Shared Pure Logic Between Server Mocks and Offline Mocks**
   - Put parsing, filtering, validation, and access rules in `src/utils/*.ts` and reuse them from both `src/server/routes/*` and `src/api/offline/*` so dev server and offline demo never diverge from the real backend contract.

---

## 3. Concurrency, State Machines & Lifecycle

1. **No Unprotected Stale Responses**
   - Every view/panel performing async `GET` loads on filter/page/language/session changes MUST cancel in-flight requests via `AbortController` (or `useQueryResource`) and abort on `onBeforeUnmount`, ignoring `REQUEST_ABORTED`.
   - Multi-step flows (e.g., `preview` → `send`) MUST capture a snapshot of the input before `await` and discard stale responses if the input changed while the request was in flight.

2. **No Silent Duplicate Mutations on Reload**
   - Never fire `POST`/`PUT`/`DELETE` automatically in `onMounted` from URL query parameters without immediately clearing the query (`router.replace`) and guarding against prior load errors.

3. **File & Resource Cleanup**
   - Validate `file.size` before calling `FileReader.readAsText`, attach `reader.onerror`, and call `reader.abort()` in `onBeforeUnmount`.
   - Clear every `setTimeout`, `setInterval`, and `window`/`document` event listener in `onBeforeUnmount`.
   - Watch `route.query` when a view reads query params on mount so same-route navigation updates state.

---

## 4. Localization, Printing & Accessibility

1. **Full `en` / `et` / `ru` Parity**
   - Every new UI string and every new backend `error_code` MUST be added to `src/locales/en.js`, `src/locales/et.js`, and `src/locales/ru.js`.
   - Escape literal `@` in `vue-i18n` messages as `{'@'}`.
   - `src/locales/i18n.test.ts` must pass with 0 compilation or key-parity errors.

2. **Print & Modal Hygiene**
   - Printable views must work cleanly with `AppLayout` chrome hidden (`print:hidden`) and avoid trailing blank pages (`last:print:break-after-auto`).
   - Modals should close on `Escape` (with listener cleanup on unmount).

---

## 5. Verification & Review Discipline

1. **Mandatory Local Gates Before Every Commit / PR**
   - `npm run lint` (`eslint .` + `vue-tsc --noEmit` + `check:openapi`)
   - `npm run test`
   - `npm run build`
2. **Honest Testing & Backlog Checklists**
   - Custom encoders/decoders (QR, CSV, Base32) require structural/round-trip verification tests, not superficial smoke checks.
   - New screens require component or integration tests covering state transitions and negative statuses (`400`/`403`/`404`/`422`/`429`).
   - Never check off a backlog acceptance criterion until its behavior and tests actually exist and pass.
3. **Independent CTO Audit**
   - Run an independent read-only CTO audit (`independent-cto-audit`) on every completed epic or multi-task feature branch **before** merging to `main`.
