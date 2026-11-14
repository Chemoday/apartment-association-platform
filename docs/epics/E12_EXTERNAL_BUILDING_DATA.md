# E12. External building data providers

- **Phase:** 2-3. **Status:** designed on 2026-11-14, documentation only (task X0
  [#139](https://github.com/Chemoday/apartment-association-platform/issues/139)); epic
  [#140](https://github.com/Chemoday/apartment-association-platform/issues/140). Planning record:
  docs/cli_planning/2026-11-14-external-building-data.md.
- **Goal:** facts about the building (a *building passport*) and the legal calendar of the
  association are filled from open public registers through country plugins, so that the board
  does not type what a state register already knows. Without a plugin, or while a register is
  down, everything works as today.
- **Country pages:** [docs/external_providers/](../external_providers/README.md), one folder per
  country.
- **Related:** the setup wizard and building administration (still to be designed; the apartment
  list proposal of X3 plugs into it), the text-only building passport groundwork of E8 and the
  equipment of E10 part B, elections of the board
  (docs/BACKLOG.md B-9), several buildings per association (B-1), notifications (E1).

This page is the design. Each task writes its part of the binding contract (docs/SCHEMA.md,
docs/API.md, docs/ARCHITECTURE.md, docs/FRONTEND_GUIDE.md) in its first commit; where they differ,
the contract wins.

## 1. How this epic is organised

The epic is a long-lived umbrella with two parts:

- **Core phases** (section 4) are written once for every country. They are finite and are ticked
  off in the epic issue. Estonia is the first country that goes through them.
- **Countries** (section 5) are added over time. Estonia, the first country, is delivered by the
  core phases X1-X5 themselves. Every later country gets its own issue, its pages under
  `docs/external_providers/{country_code}/` and its pull requests, all linked to the epic issue.

The epic issue is closed when the core phases are done and no country is in progress. A new
country later reopens it.

## 2. Owner decisions (2026-11-14)

- **Two directions are taken:** the building passport (facts about the building and its
  apartments) and the legal calendar of the association (board mandates, the annual report).
- **Live local events are not taken for now:** planned outages of electricity, water or heating,
  weather warnings and road works would need many external providers per country.
- **The response is unchanged without a plugin:** the building response gets an optional block
  `registry_facts`, `null` when no provider is enabled or nothing has been fetched yet.
  `registry_facts` holds facts about the building only, never about persons, so it is visible to
  every user of the building like the rest of `GET /api/v1/property/building` (docs/API.md: "no
  people in the payload"). The legal calendar (X4) is a separate, board-only resource. Not to be
  confused with the existing `registry_code`, the association's code in the business register.
- **Phases do not depend on the country:** they are described once; a country only adds its
  provider and its pages.
- **Open:** who holds the access to a register that needs a contract (section 7).

## 3. Principles

- **Optional and non-blocking.** A provider is a plugin enabled by configuration
  (`ENABLED_PLUGINS`, docs/ARCHITECTURE.md). Its failure, a timeout or a changed format never
  blocks a request, the start of the instance or any flow; the data simply stays as it was.
- **Plugins stay plugins.** As every plugin, a provider receives and returns plain DTOs defined in
  `src/plugins/registry.py` and has no database access. The core decides what is stored and
  shown.
- **No personal data comes in.** Personal ID codes and birth dates are never stored. Person
  fields of a source (for example who ordered an energy certificate, or the expert who issued it)
  are dropped at the plugin boundary: the DTOs have no field for them. The only exception is the
  board of the association in the legal calendar (X4): names, roles and mandate dates, shown to
  the board only and never matched to app users automatically. It is a new exception to the
  zero-PII guardrail: the contract commit of X4 adds it to AGENTS.md (section 3) and
  docs/VISION.md, with its purpose (the legal calendar), legal basis (public register data) and
  retention.
- **Owners of apartments are never fetched.** Land registers with ownership are out of scope.
- **The chairman confirms.** Fetched facts are proposals until the chairman accepts them; they
  never overwrite data entered by hand.
- **Every fact keeps its source:** the register, when it was fetched, and the attribution its
  license requires.
- **The core owns all storage:** stored facts and any download cache belong to the core (or the
  file storage of E11), never to a plugin. Credentials of a register that needs a contract are
  environment settings read through the plugin registry's settings, never in the repository.
- **Numbers are exact:** areas, volumes and heights are `Decimal` in the DTOs and `Numeric` in the
  schema, never `float`.
- **Outbound requests are bounded:** a host allowlist per provider, short timeouts, a response
  size cap, a generic User-Agent without data of the association or the user.
- **No network in tests.** Providers are tested against recorded, anonymised responses; the rest
  of the code against a fake provider.

## 4. Core phases (the same for every country)

| Task | What | Notes |
| :--- | :--- | :--- |
| X0 ([#139](https://github.com/Chemoday/apartment-association-platform/issues/139)) | This page and the country pages | documentation only |
| X1 | **Provider framework.** The provider protocol and DTOs, outbound request rules, stored facts with source, fetch time and attribution, the chairman starts a lookup, `registry_facts` in `GET /api/v1/property/building` (`null` without a provider) | a fake provider for tests and the demo |
| X2 | **Building passport.** Address -> the register's building id -> facts: year of first use, floors, lifts, areas, heating and ventilation, the energy certificate (class, date, validity) | the chairman confirms; a reminder before the certificate expires can follow through E1 |
| X3 | **Apartment list proposal** for the setup wizard: apartment numbers and areas from the register | never overwrites apartments entered by hand; depends on the setup wizard |
| X4 | **Legal calendar.** A core entity with manual entry for every country (board members' roles and mandate dates, the representation rule, the annual report deadline), pre-filled from a register where one exists | works where no register exists (section 5); names visible to the board only; reminders through E1 |
| X5 | **Refresh and discrepancies.** A periodic refresh, a hint when the register differs from the app ("register: 48 apartments, app: 47"), the state of each source | an unavailable source is shown, never fatal |

The order is X1 -> X2 -> (X3 when the setup wizard exists) -> X4 -> X5. X4 does not depend on
X2 and can move earlier.

## 5. Countries

| Country | Building passport | Legal calendar | State of the research | Pages |
| :--- | :--- | :--- | :--- | :--- |
| EE Estonia | address service and building register reachable without a key (checked live); license and terms not verified | business register: open data files without a contract; an API with a contract (terms not verified) | address service and building register **verified** on 2026-11-14; the rest from desk research | [ee/](../external_providers/ee/sources.md) |
| FI Finland | cadastre open with a free key; building data behind a data permit | business register open, the board not in the open API | not verified | [fi/](../external_providers/fi/sources.md) |
| LV Latvia | address, cadastre and building data reported as open data | enterprise register reported as open, board included | not verified | [lv/](../external_providers/lv/sources.md) |
| LT Lithuania | address data and energy certificates open; building data under a paid contract | legal entities open, the board not | not verified | [lt/](../external_providers/lt/sources.md) |
| DE Germany | cadastre depends on the federal state; energy certificates not public | reportedly no register of the owners' communities: manual entry only | not verified | [de/](../external_providers/de/sources.md) |
| PL Poland | address, parcel and building ids open; energy certificates by web search only | reportedly no register of the board: manual entry only | not verified | [pl/](../external_providers/pl/sources.md) |

Germany and Poland, where no such register is reported, are the reason why the legal calendar
(X4) is a core feature with manual entry and a register only pre-fills it.

## 6. Out of scope

- Live local events (outages, weather, road works) - see section 2.
- Paid commercial data brokers.
- Ownership of apartments (land registers), owners' names, mortgages.
- Drawings, floor plans and permit documents attached to a building record.

## 7. Open questions

- **Access to registers that need a contract** (for example an API of a business register):
  each installation signs its own contract and enters its credentials, or a managed service
  holds the contracts and passes the facts on (docs/BACKLOG.md B-1 mentions such a managed
  plane). Without either, only sources open without a contract are used.
- Size of open data files: some registers publish only whole-country files; a small instance
  should not download and filter them every night.
- How often each source is refreshed, and how a discrepancy is resolved.
