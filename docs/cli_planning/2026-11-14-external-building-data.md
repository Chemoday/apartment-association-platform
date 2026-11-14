# 2026-11-14: Data about the building from open registers (epic E12)

A record of a brainstorm with the coding agent (Claude Code CLI). Documentation only.

## 1. How we got here
- The owner asked for new directions, possibly large ones, and suggested taking information
  about the building from external open sources.
- Four directions were discussed:
  - **A.** A building passport from public registers (building register, address service,
    cadastre), which also makes the setup wizard cheaper (pre-filled building and apartments).
  - **B.** A legal calendar of the association from the business register (board mandates, the
    annual report deadline).
  - **C.** Live local events as ready drafts for the board (outages, weather warnings, road
    works).
  - **D.** Context for consumption and money (heating degree days, electricity prices,
    renovation grants).

## 2. Decisions of the owner
- A and B are taken. C is dropped for now: it would need several external providers per
  country. D was not chosen.
- A is a country plugin, Estonia first, other countries later.
- Without the plugin the response stays as it is: `registry_facts` is `null`.
- Who holds the access to registers that need a contract is not decided.
- One epic that stays open: the phases of introduction are written once for every country;
  countries are added over time with their own pages and pull requests. Country pages live in
  `docs/external_providers/{country_code}/`.

## 3. How the sources were researched
1. A short brief was given to a separate research agent: six countries (Estonia in depth,
   Finland, Latvia, Lithuania, Germany, Poland), the kinds of data, the fields to record for each
   source, rules (official sources, no accounts, no personal data, no live calls to private
   addresses).
2. Its report was checked by the coding agent for Estonia with anonymous live requests. Several
   of its claims were wrong although marked as verified:
   - the open data API v2 of the building register only orders bulk reports by e-mail; the
     per-building data comes from a different endpoint that the report did not mention;
   - the open data files of the business register contain no personal ID codes since
     1 November 2024 (the report said they did);
   - the building register does contain person names (who ordered and who issued an energy
     certificate), which must be dropped;
   - "full automation without contracts" was overstated.
3. Hence the rule of `docs/external_providers/README.md`: verified and not verified facts are
   kept apart, and no provider is built on a fact that is not verified. The research report
   itself is not part of the repository.

## 4. Result
- Epic page docs/epics/E12_EXTERNAL_BUILDING_DATA.md with the phases X0-X5.
- Country pages for EE (partly verified) and FI, LV, LT, DE, PL (not verified).
- Epic issue [#140](https://github.com/Chemoday/apartment-association-platform/issues/140), task
  X0 [#139](https://github.com/Chemoday/apartment-association-platform/issues/139).
