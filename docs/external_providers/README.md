# External data providers by country

Reference pages for epic E12 ([docs/epics/E12_EXTERNAL_BUILDING_DATA.md](../epics/E12_EXTERNAL_BUILDING_DATA.md)):
which public registers of a country can fill the building passport and the legal calendar of an
association, how to access them, and what is allowed to come in.

## Layout

```
docs/external_providers/
  README.md                 this index, the page template and the rules
  {country_code}/           lowercase ISO 3166-1 alpha-2, as src/plugins/countries/{iso}/
    sources.md              the sources of the country
    ...                     later: field mappings of a provider, notes of its tests
```

| Country | Pages | State |
| :--- | :--- | :--- |
| EE Estonia | [ee/sources.md](ee/sources.md) | partly verified (2026-11-14) |
| FI Finland | [fi/sources.md](fi/sources.md) | not verified |
| LV Latvia | [lv/sources.md](lv/sources.md) | not verified |
| LT Lithuania | [lt/sources.md](lt/sources.md) | not verified |
| DE Germany | [de/sources.md](de/sources.md) | not verified |
| PL Poland | [pl/sources.md](pl/sources.md) | not verified |

## Verification rules

- Every fact on a page is either **verified** or **not verified**. The "Sources" section only
  summarises: each of its claims is backed by the "Verified" section or listed under "Not
  verified", and a source checked in no way is marked "(not verified)" in place.
- *Verified* means: checked against the source itself (a live anonymous request, the official
  documentation or the source's own page), with the date and what exactly was seen.
- *Not verified* is everything else, including desk research by people or agents. A provider is
  never built on a fact that is not verified.
- Live checks use anonymous public endpoints and a public address (for example a government
  building), never a private home, and never credentials or personal data.
- No product names of competing association software on these pages.

## Template of `sources.md`

```markdown
# <Country>: external data sources

Last reviewed: <date>. Epic E12.

## Summary
What the building passport and the legal calendar can get in this country.

## Sources
### <Source name> (<agency>)
- Data:            ...
- Access:          REST / bulk file / OGC / web only; contract, key, eID?
- License:         ... (attribution text)
- Join ids:        ...
- Personal data:   ... and how it is kept out
- Self-hosted:     usable by an installation without a contract? yes / no / with ...

## Verified on <date>
- <what was checked, how, what was seen>

## Not verified
- <facts from desk research, to check before a provider is built>

## Open questions
```
