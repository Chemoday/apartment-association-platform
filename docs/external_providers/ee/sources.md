# Estonia: external data sources

Last reviewed: 2026-11-14. Epic E12 ([docs/epics/E12_EXTERNAL_BUILDING_DATA.md](../../epics/E12_EXTERNAL_BUILDING_DATA.md)).
First country of the epic.

## Summary

- **Building passport:** the address service turns an address into the building register code;
  one anonymous request to the building register then returns the building's facts, its parts
  (apartments and non-residential units; apartments of a residential building not verified yet),
  its energy certificates and its cadastral units. No key needed; terms of use not verified.
- **Legal calendar:** the business register publishes open data files (registry cards, persons
  on the card, annual report data) without a contract; its query API needs a contract.
- **Join ids:** the building register code (`ehrKood`, called `tunnus` in the address service),
  the address object ids (`ads_oid`, `adob_id`, `adr_id`), the cadastral unit code, the
  association's registry code (`registry_code` in `GET /api/v1/property/building`).

## Sources

### In-ADS address service (Maa- ja Ruumiamet)
- Data: normalised address, address object ids, the building register code of a building
  address.
- Access: anonymous REST/JSON, `https://inaadress.maaamet.ee/inaadress/gazetteer?address=...`.
- License: not checked yet.
- Join ids: `tunnus` (= building register code), `ads_oid`, `adob_id`, `adr_id`.
- Personal data: none seen.
- Self-hosted: technically yes (anonymous access verified); license and terms not verified.

### Building register (EHR), per-building data (Kliimaministeerium, Maa- ja Ruumiamet)
- Data: building basics (year of first use, floors, lifts, areas, volume, height), parts of the
  building (apartments and non-residential units), energy certificates, cadastral units,
  technical indicators, use and condition.
- Access: anonymous REST/JSON,
  `https://livekluster.ehr.ee/api/building/v2/buildingData?ehr_code=<code>`.
- License: not checked yet.
- Join ids: `ehrKood`, `adsOid`, `adobId`; parts have their own code `<ehrKood>-<part>`.
- Personal data: the energy certificate block names who ordered the certificate
  (`energiaTellija`, can be a private person) and the issuer (`energiaValjastNimi`). Both are
  dropped at the plugin boundary.
- Self-hosted: technically yes (anonymous access verified); license, terms and rate limits not
  verified.

### Building register (EHR), open data API v2 (bulk reports)
- Data: whole tables (buildings, building parts, addresses, energy certificates, technical data,
  cadastral links) for a county, a municipality or the whole country.
- Access: anonymous, but asynchronous: a report is ordered with `POST /api/av/v2/reports`
  (with an e-mail address and filters), the file is downloaded later from
  `GET /api/av/v2/files/{filename}`. It has **no per-building query**.
- Use for us: none for a single building; possibly for a managed service that serves many
  buildings.

### Business register (e-Äriregister, RIK), open data files
- Data: registry card data, persons on the card (the board), annual report general data and
  report elements per year.
- Access: anonymous downloads (JSON, XML, CSV in ZIP files) from
  `https://avaandmed.ariregister.rik.ee/et/avaandmete-allalaadimine`; whole-country files
  (their size not verified).
- Personal data: names of board members; no personal ID codes (see "Verified").
- Self-hosted: possible, but each file covers every company of the country.

### Business register (RIK), query API
- Data: the same per company, on request.
- Access: needs a contract with RIK (see "Not verified").
- Self-hosted: only with the association's own contract, or through a managed service (epic
  E12, section 7).

### Cadastre and restrictions (Maa- ja Ruumiamet)
- Not verified at all: cadastral unit, its area and purpose, restrictions (heritage, flood,
  radon and others) through OGC WFS/WMS services.

## Verified on 2026-11-14

Anonymous requests from the development machine, with the public address of the Maa- ja
Ruumiamet office (Mustamäe tee 51, Tallinn), which is an office building.

- **In-ADS:** `gazetteer?address=Mustamäe tee 51 Tallinn&results=1` answered HTTP 200,
  `application/json`, without a key. The result had `liikVal: EHITISHOONE`,
  `tunnus: 120221727`, `ads_oid: ME01087725`, `adr_id: 2105921`, `adob_id: 11520387` and the
  normalised address fields (`pikkaadress`, `taisaadress`, `aadresstekst`).
- **EHR per building:** `buildingData?ehr_code=120221727` answered HTTP 200 JSON without a key.
  Top-level blocks: `ehitiseKujud`, `ehitiseAndmed`, `ehitiseKehand`, `ehitiseAadressid`,
  `ehitisePohiandmed`, `ehitiseEnergiamargised`, `ehitiseKatastriyksused`,
  `ehitiseKasutusotstarbed`, `ehitiseEnergiamargisedV3`, `ehitiseTehnilisedNaitajad`.
  - `ehitiseAndmed`: `ehrKood`, `esmaneKasutus` (`1957`), `seisundTxt`, `kaosIdTxt` (use).
  - `ehitisePohiandmed`: `lift`, `maxKorrusteArv`, `minKorrusteArv`, `koetavPind`,
    `suletud_netopind`, `ehitisalunePind`, `mahtBruto`, `korgus`, `tubadeArv`,
    `mitteeluruumideArv`, `omandiLiikTxt`.
  - `ehitiseKehand.kehand[].ehitiseOsad.ehitiseOsa[]`: parts with `ehrKood`
    (`120221727-3508166`), `liik` / `liikTxt` (here `Mitteeluruum`), `kaosNimetus`.
  - `ehitiseEnergiamargised.energiamargis[]`: `energiaKlass`, `dok_nr`, `dokLiik`, `seisund`,
    `energiaValjastKp`, `etaKekVal` / `etaKekType`, plus the person fields `energiaTellija` and
    `energiaValjastNimi`.
  - Areas and counts are strings with a decimal point (`"10792.2"`): parsed as `Decimal`.
- **EHR open data API v2:** `GET /api/av/v2/openapi.json` (version 0.0.42) lists only report
  metadata (`GET /reports`, `GET /reports/{report_code}`), ordering (`POST /reports`, body
  `report_code`, `email_address`, `report_format` (default `csv`), `point_kdate` and filters such
  as `county`, `district`, `town`, `seisund`, `kaos`) and downloads (`GET /files/{filename}`).
  `GET /reports` lists, among others, `eh_ehitised`, `eh_ehitis_osad`, `ad_aadress`,
  `katastriyksus`, `ehitis_aadress`, `hoone_energia_margised`, `eh_tehna`, `ehitis_kaos`.
- **RIK open data page:** lists the files `ettevotja_rekvisiidid__lihtandmed`, `__yldandmed`,
  `__registrikaardid`, `__kaardile_kantud_isikud`, `__kandevalised_isikud`, `__osanikud`,
  `__kasusaajad`, `__kommertspandid`, `__maarused` (JSON and/or XML, ZIP), and annual report
  files (`aruannete_yldandmed`, `aruannete_elemendid` per year 2019-2025). The page states that
  since 1 November 2024 the open data files contain no personal ID codes, and that since
  10 July 2026 beneficial owners are no longer published.

## Not verified

- Licenses and attribution texts of every source (desk research says CC BY 4.0 with
  "Maa- ja Ruumiamet" / "Äriregister, RIK"; to be read on the sources' own pages).
- Apartment data of a **residential** building: whether `ehitiseOsad` lists every apartment with
  its number and area (only an office building was checked).
- Whether the registry card of an apartment association carries the end date of each board
  member's mandate, and the representation rule.
- The query API of RIK: a contract, free when only the API is used, login with an e-Business
  Register user, about 50,000 answers per day (from a search result of RIK's introduction page,
  the page itself was not read).
- Size of the whole-country RIK files (desk research says about 10 GB unpacked).
- Cadastre WFS layers and their restrictions data.
- Restrictions of public access to EHR documents after the privacy debate reported by ERR in
  2025-2026; they are said to cover attached documents and drawings, not the structured data.

## Open questions

- A residential test address that is public and acceptable for live checks.
- Whether the per-building EHR endpoint is meant for third-party use and has rate limits.
- RIK access model for the legal calendar (epic E12, section 7).
