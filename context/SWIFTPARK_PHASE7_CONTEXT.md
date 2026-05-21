# SwiftPark Phase 7 Command Center Context

_Last updated: 2026-05-21_

## Purpose of this file

This file gives the SwiftPark Command Center agents enough context to work on Phase 7 without drifting into unrelated features or generic product work.

Use this as the default project context for Phase 7 planning, coding, QA, and status updates.

---

## Current SwiftPark vision

SwiftPark is a **camera-first parking intelligence platform**.

The core product vision is:

> Turn existing parking/security cameras into live parking intelligence for operators and lightweight driver guidance for users.

Core product loop:

```text
Existing cameras
→ live spot / zone occupancy
→ operator dashboard
→ QR/mobile web driver guidance
→ final-step navigation
→ reports / Neo insights
```

SwiftPark should not be framed as just another downloadable parking app.

The operator is the early paying customer. The driver-facing product should initially be a **no-download mobile web experience** distributed through:

- QR codes at parking locations
- operator websites
- hotel/resort booking links
- event pages
- SMS/email parking status links
- digital signage / public parking pages

---

## Strategic positioning

Best positioning:

```text
SwiftPark turns existing cameras into live parking visibility, operator recommendations, and QR-accessible driver guidance.
```

Avoid leading with:

```text
- another consumer parking app
- a SpotHero / ParkMobile / JustPark clone
- a broad payment or reservation marketplace
- a generic AI dashboard
- a custom consulting shop with no repeatable platform
```

Short-term product framing:

```text
Operator dashboard = business / revenue product
Mobile web page = public driver guidance surface
Native app = future network-stage product, not the first deployment path
```

The product should feel like:

```text
Scan QR → See best zone → View live map → Navigate → Park
```

---

## Current repo context

Product repo:

```text
parking_cv/
  backend/      mock/demo + YOLO APIs
  frontend/     existing demo app + dashboard
  mobile-web/   new QR/mobile public driver web app
```

Important rule:

> The existing `frontend/` demo app should remain safe. Do not modify it unless explicitly instructed.

The new `mobile-web/` app is the public QR/mobile driver product surface.

---

## Backend services

Mock/demo backend:

```text
backend/mock_main.py
runs on 127.0.0.1:8000

GET /demo/occupancy
GET /demo/brighton-mock-zones
```

YOLO backend:

```text
backend/main.py
runs on 127.0.0.1:8001

GET /status
WS /ws
```

Brighton Zone 1 should use YOLO `/status`.

Brighton Zones 2/3 should use `/demo/brighton-mock-zones`.

OSU should use `/demo/occupancy`.

---

## Phase 7A status

Phase 7A is complete and merged into `main`.

Completed:

```text
- mobile-web app created separately from frontend
- /f/:facilitySlug
- /f/:facilitySlug/map
- /f/:facilitySlug/spot/:spotId
- /f/:facilitySlug/navigate?spot=...
- /f/:facilitySlug/parked?spot=...
- Brighton Zone 1 reads YOLO /status
- Brighton Zones 2/3 read /demo/brighton-mock-zones
- OSU reads /demo/occupancy
- counts are consistent through occupancy.sections
- mobile-web UI has SwiftPark branding and polished foundation
```

Important data rule:

```text
occupancy.sections is the source of truth.
Do not invent counts.
Do not mix YOLO aggregate capacity with mapped spot counts unless clearly labeled.
```

Counts in:

```text
facility page
zone/level cards
spot map
spot details
navigation page
parked page
```

should all derive from the same normalized `FacilityOccupancy.sections` data.

---

## Phase 7 roadmap

```text
Phase 7B — Google Maps + final-step navigation
Phase 7C — GLB 3D spot map for mobile-web
Phase 7D — Operator dashboard controls for public driver page
Phase 7E — Neo MVP: insights, recommendations, reports
Phase 7F — Pilot packaging: QR links, one-pager, demo video
```

Build the real pilot loop first:

```text
Driver scans QR
→ sees best zone
→ views live map
→ opens Maps to entrance
→ SwiftPark guides final step
→ operator can update public recommendation
→ Neo explains what to do next
```

---

# Phase 7B — Google Maps + final-step navigation

## Status

The Google Maps phase should be treated as **not complete** until an API key is created, added locally, and tested.

The user currently does not have a Google Maps API key available.

Some code may already exist for Google Maps fallback / optional embed support, but agents should inspect the repo before assuming Phase 7B is complete.

## Product principle

```text
Maps gets the driver to the entrance.
SwiftPark guides the final parking step.
```

Do not claim Google Maps can route directly through every garage aisle/private lot unless SwiftPark owns that private route model.

## Expected implementation

Use two layers:

```text
1. Google Maps URL
   Opens real navigation in Google Maps.
   Does not require an API key.

2. Google Maps Embed API
   Shows an in-page route preview inside SwiftPark.
   Requires VITE_GOOGLE_MAPS_API_KEY.
```

Keep the external `Open in Google Maps` button even if the embed exists.

## Google Maps API key guidance

The founder/user or Kensan should create this manually in Google Cloud because it involves Google Cloud project ownership, billing, API restrictions, and credentials.

The Command Center team can:

```text
- implement the code
- add .env.example entries
- verify fallback behavior
- test the key once provided
- document setup steps
```

The Command Center should not create/manage Google Cloud billing credentials unless the user explicitly provides access.

### Setup steps for user/Kensan

```text
1. Create/select Google Cloud project, e.g. SwiftPark Maps
2. Link billing
3. Enable Maps Embed API
4. Create API key
5. Restrict by website referrer
6. Restrict to Maps Embed API
7. Add to mobile-web/.env.local as VITE_GOOGLE_MAPS_API_KEY=...
```

Local referrers:

```text
http://127.0.0.1:5177/*
http://localhost:5177/*
```

Production referrers later:

```text
https://swiftpark.live/*
https://www.swiftpark.live/*
```

## Desired Phase 7B behavior

On:

```text
/f/:facilitySlug/navigate?spot=S02
```

show:

```text
- selected spot / zone / level
- destination entrance
- Google Maps preview if API key exists
- fallback static route preview if API key is missing
- Open in Google Maps CTA
- SwiftPark final guidance card
- I've Parked CTA
```

---

# Phase 7C — GLB 3D Spot Map

Goal:

```text
Upgrade /f/:facilitySlug/map with a mobile-friendly 3D GLB spot visualization.
```

Requirements:

```text
- reuse car model assets/style from existing demo if possible
- lazy-load WebGL/GLB only on the map page
- keep 2D fallback
- show available / occupied / unknown / selected
- allow selecting available spots
- preserve existing data source of truth
- do not load GLB scene on the main facility page
```

The 3D spot map is a major SwiftPark differentiator.

The facility page should stay fast and recommendation-first. The GLB scene should load only after the user taps:

```text
View Live Map / View Spot Map
```

---

# Phase 7D — Operator Dashboard Controls

Add controls so operators can manage what the public mobile page shows:

```text
- set recommended zone/level
- edit public message
- preview public mobile page
- copy QR link
- copy public URL
- activity log of recommendation/message changes
```

This creates the real operator loop:

```text
Camera detects occupancy
→ dashboard shows state
→ operator/Neo recommends action
→ public mobile page updates
→ drivers follow guidance
```

The dashboard should become an **operations command center**, not just a demo analytics page.

Useful operator modules:

```text
- Business Overview
- Live Lot Intelligence
- Public Driver Page controls
- Cameras & Zones
- Recommendations / Neo Insights
- Activity Log
- Reports / Weekly Audit
- Long-Dwell & Policy Exceptions
```

Avoid making the whole product only “Audit.” Audit can be one module.

---

# Phase 7E — Neo MVP

Neo is the planned customer-facing parking operations assistant.

Do not confuse Neo with internal Command Center agents.

Initial Neo MVP should be insight/action cards, not full open-ended chat.

Neo should help operators with:

```text
- route drivers to Zone 2
- detect stale camera feed
- copy SMS alert
- suggest public page update
- generate pilot report
- explain recommendations
```

Neo must be grounded in SwiftPark data and should not invent facts.

Example Neo output:

```text
Zone 1 is nearing capacity while Zone 2 has the best availability.

Recommendation:
Route new arrivals to Zone 2.

Actions:
[Update public page]
[Copy SMS alert]
[Generate report]
```

Neo should start with:

```text
1. Insight cards
2. Report generator
3. Suggested actions
4. Limited guided prompts
```

Not with a broad generic chat interface.

---

## Operator dashboard direction

The operator dashboard should answer:

```text
What is happening right now?
Where should drivers go?
Are cameras/data healthy?
What changed today?
What should staff do next?
What should be reported to leadership?
```

Useful dashboard metrics/features:

```text
- current occupancy
- peak occupancy
- priority-zone availability
- long-dwell sessions
- occupancy by hour
- lot health
- camera health
- detection confidence
- low-confidence / unknown rate
- blocked or policy-exception spaces
- recommendations
- public driver page state
- QR link / preview
- activity log
- daily / weekly report
```

For sessions/dwell time:

```text
- A session starts when a spot is occupied for N consecutive observations.
- A session ends when a spot is available for M consecutive observations.
- Unknown should pause the session, not instantly end it.
- Low-confidence observations should not trigger major events alone.
```

If there is no LPR, do not say “same vehicle confirmed.” Use cautious wording:

```text
possible long-dwell vehicle
possible policy exception
stationary occupancy observed
```

---

## Product guardrails

Do not prioritize yet:

```text
- full payments
- full reservations
- LPR
- full AI chat
- deep external integrations
- native app distribution
```

Build the pilot loop first.

Potential future modules:

```text
- SMS/email parking status
- digital signage feed
- website embed
- event parking mode
- reservations
- payments
- LPR/security
- permit/visitor parking workflows
```

These are later, not Phase 7 core unless explicitly requested.

---

## Development guardrails for Command Center agents

When working on SwiftPark:

```text
- identify repo path and branch before editing
- prefer plan-only first for major work
- preserve existing frontend demo unless explicitly instructed
- preserve backend/CV/YOLO unless explicitly instructed
- run build checks before reporting success
- do not commit/push without explicit approval
- summarize files changed, validation, and caveats
```

Do not commit:

```text
node_modules/
dist/
.vite/
.next/
.claude/
local env files
```

---

## Validation commands

Mobile web build:

```powershell
cd mobile-web
npm.cmd run build
npm.cmd run dev -- --host 127.0.0.1 --port 5177 --strictPort --force
```

Important routes:

```text
/f/brighton-ski-resort
/f/osu-structure-1
/f/brighton-ski-resort/map
/f/brighton-ski-resort/spot/S02
/f/brighton-ski-resort/navigate?spot=S02
/f/brighton-ski-resort/parked?spot=S02
```

Backends for full local test:

```powershell
# mock backend
cd backend
..\venv\Scripts\Activate.ps1
python -m uvicorn mock_main:app --reload --host 127.0.0.1 --port 8000

# YOLO backend
cd backend
..\venv\Scripts\Activate.ps1
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8001
```

Direct backend checks:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/demo/occupancy
Invoke-RestMethod http://127.0.0.1:8000/demo/brighton-mock-zones
Invoke-RestMethod http://127.0.0.1:8001/status
```

---

## Good Phase 7B Goal Prompt for Command Center

```text
Phase 7B: Implement/test Google Maps + final-step navigation for mobile-web.

Work only in parking_cv/mobile-web unless absolutely necessary. Preserve existing frontend demo app, backend, CV, and YOLO logic. Add/verify facility entrance config, section-to-entrance mapping, Google Maps URL directions, and optional Google Maps Embed preview when VITE_GOOGLE_MAPS_API_KEY exists. If no API key exists, preserve the static fallback preview. Do not commit without approval. Run npm build and verify navigation routes.
```

---

## Good Phase 7C Goal Prompt for Command Center

```text
Phase 7C: Add a mobile-friendly GLB 3D spot map to mobile-web.

Work only in parking_cv/mobile-web unless absolutely necessary. Preserve existing frontend demo app, backend, CV, and YOLO logic. Use existing mobile-web data and route structure. Replace or enhance the current /f/:facilitySlug/map spot preview with a lazy-loaded SpotMap3D component using existing car model assets if possible. Keep a 2D fallback. Show available/occupied/unknown/selected states and allow selecting available spots. Run npm build and verify Brighton/OSU map routes. Do not commit without approval.
```

---

## Good Phase 7D Goal Prompt for Command Center

```text
Phase 7D: Add operator dashboard controls for the public mobile web page.

Goal: operators should be able to set recommended zone/level, edit public message, preview the driver page, copy QR link, and copy public URL. Preserve existing dashboard and mobile-web behavior. Keep this as an operator control surface, not a full redesign. Do not implement Neo chat yet. Run builds and summarize changes. Do not commit without approval.
```

---

## Good Phase 7E Goal Prompt for Command Center

```text
Phase 7E: Build Neo MVP as dashboard insight cards and report actions.

Neo should be grounded in SwiftPark occupancy, camera health, and public page data. Do not build open-ended chat first. Add recommendation cards such as route drivers to Zone 2, camera feed stale, generate pilot report, copy SMS alert. Actions should require operator approval where they affect public guidance. Do not invent facts. Do not commit without approval.
```

---

## Key message for team

The near-term goal is a real pilot workflow:

```text
Driver scans QR
→ sees best zone
→ views live map
→ opens Maps to entrance
→ SwiftPark guides final step
→ operator can update public recommendation
→ Neo explains what to do next
```

Build that loop first.
