# Lithuania: external data sources

Last reviewed: 2026-11-14. Epic E12 ([docs/epics/E12_EXTERNAL_BUILDING_DATA.md](../../epics/E12_EXTERNAL_BUILDING_DATA.md)).
**Nothing on this page is verified yet.** It summarises desk research of 2026-11-14; every fact
must be checked against the source before a provider is built (see [the rules](../README.md)).

## Summary
- **Building passport:** address data and energy certificates are reported as open data;
  detailed building data of the real estate register needs a paid contract.
- **Legal calendar:** legal entity data (code, status, annual reports) is open; the board is not.

## Sources (not verified)
### Centre of Registers: addresses and real estate register (VĮ Registrų centras)
- Data: address code, unique real estate number, year, area, dwelling count, walls, heating.
- Access: periodic bulk files on data.gov.lt (addresses, general data); live building data
  through a paid commercial agreement.

### Centre of Registers: register of legal entities (JAR)
- Data: entity code (for example of a DNSB, an apartment owners' association), name, legal form,
  status, annual report filing.
- Access: open datasets on data.gov.lt. The board needs eID access or paid extracts.

### Energy certificates (Statybos sektoriaus vystymo agentūra)
- Data: class, certificate number, dates, primary energy use.
- Access: open dataset on data.gov.lt and a public web search.
- Join id: unique building number or address.

## Open questions
- Whether the open address data includes the unique number of each building.
