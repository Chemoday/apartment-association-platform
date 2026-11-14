# Latvia: external data sources

Last reviewed: 2026-11-14. Epic E12 ([docs/epics/E12_EXTERNAL_BUILDING_DATA.md](../../epics/E12_EXTERNAL_BUILDING_DATA.md)).
**Nothing on this page is verified yet.** It summarises desk research of 2026-11-14; every fact
must be checked against the source before a provider is built (see [the rules](../README.md)).

## Summary
Reported as the most open of the researched countries: address, cadastre, building data with
energy certificates and the enterprise register with the board are all said to be open data on
data.gov.lv.

## Sources (not verified)
### State Address Register and cadastre (Valsts zemes dienests)
- Data: address code, building cadastral designation, parcel number, coordinates.
- Access: bulk files (CSV, SHP) and the CKAN API of data.gov.lv, without a key.

### Construction Information System (BIS, Būvniecības valsts kontroles birojs)
- Data: building dossier (year, structure, area, apartment count), energy certificates
  (class, dates), acceptance decisions.
- Access: open datasets on data.gov.lv (reported monthly); private documents need an eID.
- Join id: building cadastral designation.

### Register of Enterprises (Uzņēmumu reģistrs)
- Data: registration number, legal form, address, officers (board) with appointment dates,
  representation rights, annual report filing.
- Access: open datasets on data.gov.lv, reported as CC0.
- Personal data: names and birth dates of officers; personal codes reported as removed. Only
  names, roles and appointment / mandate dates may be taken; birth dates and personal codes are
  dropped at the plugin boundary.

## Open questions
- Whether apartment associations (the legal forms used for apartment owners) are covered with
  their boards.
- Update frequency and size of the files.
