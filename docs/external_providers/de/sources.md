# Germany: external data sources

Last reviewed: 2026-11-14. Epic E12 ([docs/epics/E12_EXTERNAL_BUILDING_DATA.md](../../epics/E12_EXTERNAL_BUILDING_DATA.md)).
**Nothing on this page is verified yet.** It summarises desk research of 2026-11-14; every fact
must be checked against the source before a provider is built (see [the rules](../README.md)).

## Summary
- **Building passport:** cadastral parcels and building footprints are open in some federal
  states and paid in others; there is no public source of building facts or energy certificates.
- **Legal calendar:** an owners' community (*Wohnungseigentümergemeinschaft*, WEG) is reported
  as not being recorded in any public register, so mandates and deadlines are entered by hand.
  This is why the legal calendar is a core feature with manual entry (epic E12, X4).

## Sources (not verified)
### Cadastre of the federal states (ALKIS, state geoportals)
- Data: parcel id (*Flurstückskennzeichen*), area, actual use, building footprints.
- Access: OGC WFS/WMS; free in some states (reported: NRW, Berlin, Hamburg, Thuringia, Hesse,
  under *Datenlizenz Deutschland - Namensnennung 2.0*), contracts and fees in others.
- Personal data: none (ownership is in the land register, *Grundbuch*, which needs a legitimate
  interest).

### Energy certificate registration office (DIBt)
- Reported as an internal database for random checks only: no public API and no public search.
  Certificates would be uploaded by the board as documents.

### Commercial register
- Owners' communities are reported as not registered there; the administrator and the advisory
  board appear only in the community's own collection of resolutions.

## Open questions
- Which states give open WFS access suitable for an installation, and under which license.
