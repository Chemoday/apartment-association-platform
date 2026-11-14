# Finland: external data sources

Last reviewed: 2026-11-14. Epic E12 ([docs/epics/E12_EXTERNAL_BUILDING_DATA.md](../../epics/E12_EXTERNAL_BUILDING_DATA.md)).
**Nothing on this page is verified yet.** It summarises desk research of 2026-11-14; every fact
must be checked against the source before a provider is built (see [the rules](../README.md)).

## Summary
- **Building passport:** cadastral data is open with a free key; technical building data and
  energy certificates are behind permits or contracts, so most of the passport is entered by hand.
- **Legal calendar:** the business register's open API gives the housing company's identity,
  status and the filing of financial statements, but not the board.

## Sources (not verified)
### PRH / YTJ open data API (Patentti- ja rekisterihallitus)
- Data: business id (`Y-tunnus`), company form (housing company `ASO`), name, status, domicile,
  filing dates of financial statements.
- Access: open REST/JSON without a key. License: reported as CC BY 4.0.
- Personal data: none in the open API; board members and signatories are not in it (they are in
  the paid trade register extracts).

### Building and dwelling register (DVV, VTJ-PRT; RYHTI)
- Data: permanent building id, year, floors, dwellings, areas, heating, materials.
- Access: data permit, X-Road or a certified distributor, fees. Self-hosted: no.

### National Land Survey open data (Maanmittauslaitos)
- Data: property id (`kiinteistötunnus`), parcel geometry and area.
- Access: OGC API Features / WFS with a free API key. License: reported as CC BY 4.0.
- Personal data: none (ownership is in a separate, closed system).

### Energy certificate register (ARA)
- Data: class, dates, consumption.
- Access: public web search only; machine access through X-Road with a contract. Self-hosted:
  only a link to the web search.

## Open questions
- Whether the free API key of the land survey can be used by every installation.
- Whether any open source gives the dwelling count and areas.
