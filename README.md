# Semester Board

A React/Vite semester dashboard with an aligned daily board, assignment and attendance tracking, private cross-device accounts, a synced course-document library, document-first semester setup, a standalone Study Deck, an on-device schedule helper, optional cloud AI chat, and optional closed-tab Web Push reminders. The public app starts with no courses or coursework. If Supabase is not configured, the device-only profile flow remains available without pretending that it syncs.

## What runs where

| Feature | Default location | Data that leaves the browser |
| --- | --- | --- |
| Account identity | Supabase Auth | Email, password handled by Supabase Auth, and display name |
| Progress and attendance | Supabase Postgres + owner-scoped browser cache | Attendance/check-in records and notes, assignment completion, verified date overrides, and schedule choices |
| Course documents | Private Supabase Storage + owner-scoped metadata | Syllabi, assignment sheets, exam guides, calendars, and their course/file metadata, only after the user approves a generated semester draft or uploads directly |
| Semester draft generation | Vercel Function + AI Gateway, only after consent | File names and bounded text excerpts from up to eight user-selected course documents; the user reviews the resulting courses, schedules, office hours, and coursework before saving |
| Private lookup | Supabase Postgres for cloud accounts; browser for device-only profiles | Saved assistant history for a cloud account; no AI provider request in Private lookup mode |
| Semester Chat | Vercel Function + AI Gateway, only after consent | Chat messages plus a minimized snapshot of course names, class times/rooms, upcoming work/exams, aggregate attendance counts, and reminder times |
| Closed-tab reminders | Service worker + Vercel Workflow, only after consent | A Web Push subscription plus opaque reminder hashes, categories, and timestamps |

Course names, assignment titles, notification copy, attendance records, syllabus files, and private-lookup history are not included in the push schedule. The service worker looks up notification copy in IndexedDB on the subscribed device. Cloud-account assistant histories sync as account data; sending a message to the configured AI provider still requires separate, expiring consent. The consent marker, notification permission, push subscription, auth-session cache, and Study Deck session/media remain device-specific.

The assistant is software, not a human support agent or an unrestricted AI. It cannot inspect Canvas or external accounts. It can process bounded excerpts from documents the user selects inside Semester Board, but generated records remain a draft until the user reviews and saves them. It cannot submit coursework or change Canvas records.

## Privacy and delivery boundaries

- Supabase-backed account data is protected by Auth, explicit table grants, Row Level Security ownership policies, and a private Storage bucket. It is not end-to-end encrypted by Semester Board.
- The browser keeps an owner-scoped offline cache. Browser storage is not encrypted; signing out hides it from the app but does not securely erase the browser profile or operating-system storage.
- Device-only profiles continue to use localStorage and IndexedDB. Clearing site data can remove those local records and files.
- A local profile passphrase and PBKDF2 verifier are never converted to or uploaded as a cloud password. Moving an existing profile requires selecting it, entering its local passphrase, reviewing a manifest, and explicitly confirming the upload; the original local copy is preserved.
- A Web Push subscription is a secret capability and is sent only after the user explicitly enables closed-tab reminders.
- Web Push delivery is best effort. Browser, operating-system, battery, Focus/Do Not Disturb, and push-provider policies can delay or suppress a banner.
- Notification permission must come from a user gesture. If the browser reports `Denied`, the app cannot override it; the user must change the site permission and reload.
- On supported Apple mobile devices, Web Push generally requires installing the site to the Home Screen first.
- The website and its assistant do not poll Canvas. A user may enter or privately import records they have independently verified, but Semester Board does not claim that those records are current unless the account owner maintains them.
- Document-first setup extracts readable text in the browser, sends only bounded excerpts and file names after explicit AI consent, and saves the original files only after the user approves the draft. Generated schedules and deadlines can be incomplete or wrong; unstated dates remain blank instead of being guessed.
- The public source tree and client bundle contain only an empty semester template. Course names, assignments, schedules, source references, and Canvas evidence belong to the signed-in account state and are not public defaults.
- `noindex` discourages search indexing; it is not access control. Account records and uploaded files depend on Supabase Auth, owner-scoped Row Level Security, and private Storage policies for access control.
- The signed cloud-consent cookie proves consent, not identity. Semester Chat uses a server-allowlisted model, is bounded to 12 text messages / 12,000 chat characters / 32 KiB / 600 output tokens plus a 64-fact / 16,000-character minimized board snapshot, has no provider retry, and uses best-effort per-IP and per-consent limits in each warm function instance.
- Push sync and test requests also have bounded best-effort per-IP and per-subscription limits in each warm function instance. These in-memory brakes reset on cold starts, are not shared across instances, and are not a distributed WAF.
- A dedicated budgeted `AI_GATEWAY_API_KEY` is the aggregate spending backstop for the production deployment. Keep its budget and auto-top-up policy deliberate; a budget is not a distributed request-rate limit.
- Before broad public sharing, add authentication or a published Vercel WAF rate limit for `/api/chat`, `/api/push/sync`, and `/api/push/test`. Function-memory limits reset on cold starts, and same-origin checks stop browser CSRF but do not authenticate arbitrary HTTP clients.

## Local development

Use Node.js 24 and pnpm:

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5173/`. Copy `.env.example` to `.env.local` and populate the variables to exercise accounts, cloud chat, and push. For local AI Gateway calls outside Vercel, provide `AI_GATEWAY_API_KEY`; a linked Vercel development environment can instead supply its OIDC credentials.

For cross-device accounts, create a dedicated Supabase project and apply every migration in `supabase/migrations/` in timestamp order. Then use that project’s URL and browser-safe publishable key. Configure both the local and production URLs as allowed Auth redirect URLs. Do not use an unrelated Supabase project and do not put a service-role or secret key in a `VITE_` variable.

Generate the VAPID public/private key pair together. Keep `VAPID_PRIVATE_KEY`, `AI_CONSENT_SIGNING_SECRET`, and `PUSH_SIGNING_SECRET` server-only.

## Verification

```bash
pnpm test
pnpm run build
pnpm run build:offline
```

The normal build uses Nitro and Vercel Workflow and emits `.output/`. The offline build keeps the original single-file export path in `dist/`; cloud chat and closed-tab push are unavailable in that offline artifact.

## Vercel configuration

Set these variables for each environment that should support the server features:

```text
AI_CONSENT_SIGNING_SECRET
AI_GATEWAY_API_KEY
PUSH_SIGNING_SECRET
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT=https://fall-2026-quest.vercel.app
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

`AI_GATEWAY_MODEL` is optional. Leave it unset to use the server default; if set, it must match the allowlist in [api/chat.post.js](api/chat.post.js).

The production deployment uses a dedicated budgeted AI Gateway key. Vercel OIDC is a keyless alternative, but it does not provide that workload-key budget boundary. Workflow durability and sleep scheduling are provided by Vercel Workflow; no minute-by-minute cron job is used.

Semester Chat also requires an activated AI Gateway credit setup. If the Gateway account or provider rejects a request, the API returns a generic `502` and the UI keeps Private lookup available; it never reports an empty provider stream as a successful answer.
