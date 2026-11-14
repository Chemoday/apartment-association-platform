# Poland: external data sources

Last reviewed: 2026-11-14. Epic E12 ([docs/epics/E12_EXTERNAL_BUILDING_DATA.md](../../epics/E12_EXTERNAL_BUILDING_DATA.md)).
**Nothing on this page is verified yet.** It summarises desk research of 2026-11-14; every fact
must be checked against the source before a provider is built (see [the rules](../README.md)).

## Summary
- **Building passport:** address points, parcel and building ids and footprints are open
  through the national geodesy services; energy certificates only by web search; heating
  sources are in a closed register.
- **Legal calendar:** a housing community (*wspólnota mieszkaniowa*) is reported as not being in
  the court register, so its board is in no public register: manual entry only (epic E12, X4).

## Sources (not verified)
### Geodesy and cartography services (GUGiK: ULDK, ULB, PRG)
- Data: building id, parcel id, footprint geometry, administrative codes (TERYT), coordinates.
- Access: open REST / OGC services without a key.
- Personal data: none (land and mortgage registers are separate).

### Statistical business register (GUS, REGON / BIR1.1)
- Data: REGON and NIP of the community, name, address, start date.
- Access: REST/SOAP with a free user key requested from GUS.
- The board is not in it.

### Energy certificate register (CHEB, Ministry of Development and Technology)
- Public web search only, no public API.

### Central register of building emissions (CEEB, GUNB)
- Closed to third-party software (citizen login only).

## Open questions
- Whether one free GUS key per installation is acceptable under its terms.
