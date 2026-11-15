# Estonia: the building facts block `ee/1`

Last reviewed: 2026-11-15. Epic E12, task X2 (design; the binding contract is written into
docs/API.md by the first commit of X1/X2). Source: the per-building endpoint of the building
register, `https://livekluster.ehr.ee/api/building/v2/buildingData?ehr_code=<code>`
([sources.md](sources.md)); the paths below are relative to its `ehitis` object.

The block is what `registry_facts` holds for a building in Estonia (epic E12, section 2a). The
client renders it with a view for Estonia. Every field may be `null`: the register leaves fields
empty (on the residential building checked, the minimum floor count was empty, and the building
had no energy certificate).

## Rules
- **Numbers:** areas, volumes and heights come as strings with one decimal place
  (`"10792.2"`); they are parsed as `Decimal` and returned as decimal strings as received, never
  as floats. Counts come as strings of digits (`"2"`) and are returned as integers; a value that
  is not a whole number becomes `null` and is logged without the value.
- `building.heated_area_m2` is the register's figure. It differs on purpose from
  `heated_area_m2` of `GET /api/v1/property/building`, the sum of the app's apartment areas; the
  difference is an input for the discrepancy hints (X5).
- Every field was seen in a live answer (sources.md, "Verified") unless marked
  *(not verified)*.
- **Texts of the register are Estonian.** A classified value is returned as its code and the
  register's Estonian text; the client translates known codes and shows the Estonian text
  otherwise.
- **Never taken:** who ordered an energy certificate (`energiaTellija`), who issued it
  (`energiaValjastNimi`, `energiaValjastRegkood`), the certificate's free-text `kommentaar`, any
  person or owner, attached documents and drawings, geometry,
  the free text `lisavaartus` of technical indicators (not reviewed for personal data; may come
  in a later schema).

## Shape

```json
{
  "country_code": "EE",
  "schema": "ee/1",
  "source": {"register": "EHR", "building_code": "...", "fetched_at": "2026-11-15T09:00:00Z",
             "attribution": "Ehitisregister"},
  "building": {"first_use_year": 1957, "purpose": {"code": "...", "label_et": "..."}, "...": "..."},
  "units": [{"number": "14", "kind": "APARTMENT", "area_m2": "54.30", "...": "..."}],
  "energy_certificates": [],
  "technical": [{"group": {"code": "KONS_KKONSTR", "label_et": "..."},
                 "value": {"code": "212", "label_et": "..."}}],
  "cadastral_units": [{"code": "..."}]
}
```

## `building`

| Field | EHR path | Type | Note |
| :--- | :--- | :--- | :--- |
| `first_use_year` | `ehitiseAndmed.esmaneKasutus` | integer | year of first use |
| `purpose` | `ehitiseAndmed.kaosIdPeamine`, `.kaosIdTxt` | code + label | main use |
| `state` | `ehitiseAndmed.seisund`, `.seisundTxt` | code + label | e.g. existing |
| `ownership` | `ehitisePohiandmed.omandiLiik`, `.omandiLiikTxt` | code + label | the form, never an owner |
| `construction_started_on` | `ehitisePohiandmed.ehAlustKp` | date | |
| `floors_max`, `floors_min` | `ehitisePohiandmed.maxKorrusteArv`, `.minKorrusteArv` | integer | `floors_min` was empty on the residential building checked |
| `lifts` | `ehitisePohiandmed.lift` | integer | |
| `rooms` | `ehitisePohiandmed.tubadeArv` | integer | |
| `non_residential_units` | `ehitisePohiandmed.mitteeluruumideArv` | integer | |
| `closed_net_area_m2` | `ehitisePohiandmed.suletud_netopind` | decimal | |
| `heated_area_m2` | `ehitisePohiandmed.koetavPind` | decimal | |
| `common_area_m2` | `ehitisePohiandmed.yldkasut_pind` | decimal | common-use area |
| `auxiliary_area_m2` | `ehitisePohiandmed.abiruumidePind` | decimal | |
| `footprint_m2` | `ehitisePohiandmed.ehitisalunePind` | decimal | |
| `volume_m3` | `ehitisePohiandmed.mahtBruto` | decimal | gross volume |
| `height_m` | `ehitisePohiandmed.korgus` | decimal | empty on the residential building checked |

## `units` (parts of the building)

From `ehitiseKehand.kehand[].ehitiseOsad.ehitiseOsa[]`.

| Field | EHR path | Type | Note |
| :--- | :--- | :--- | :--- |
| `number` | `tahis` | string | the apartment number; `null` for a common-use part |
| `kind` | `liik` | `APARTMENT` (`K`), `NON_RESIDENTIAL` (`M`), `COMMON` (`Y`) | an unknown letter becomes `OTHER` |
| `area_m2` | `ehitiseOsaPohiandmed.pind` | decimal | filled on every part checked; `ehitiseKasutusotstarbed[].eluruumidePind` was empty per part |
| `heated_area_m2` | `ehitiseOsaPohiandmed.koetavPind` | decimal | rarely filled |
| `rooms` | `ehitiseOsaPohiandmed.tubadeArv` | integer | |
| `toilets` | `ehitiseOsaPohiandmed.tualettruumide_arv` | integer | |
| `entrance_floor` | `ehitiseOsaPohiandmed.sissepaasuKorrus` | integer | the floor of the apartment's entrance |

- **No entrance (staircase) number** per apartment in the register; the setup wizard asks for it.
- Ordered by `number` in natural order (`2`, `10`, `14`, `14A`); common parts last.

## `energy_certificates`

From `ehitiseEnergiamargised.energiamargis[]` (the block `ehitiseEnergiamargisedV3` was empty
on both buildings checked). Can be an empty list.

| Field | EHR path | Type |
| :--- | :--- | :--- |
| `energy_class` | `energiaKlass` | string (`A`..`H` *(range not verified)*) |
| `document_number` | `dok_nr` | string |
| `document_kind` | `dokLiik` | `label_et` only: the answer has no code for it |
| `state` | `seisund` | code only (`DO_DOKUSEIS_KEHTIV`): the answer has no text for it |
| `issued_on` | `energiaValjastKp` | date |
| `valid_until` | `energiaKehtibKuniKp` | date |
| `value`, `value_type` | `etaKekVal`, `etaKekType` | integer (a string of digits in the answer); `KEK` seen, `ETA` *(not verified)* |

## `technical`

From `ehitiseTehnilisedNaitajad.tehnilineNaitaja[]` (the building) as a list of
`{group: {code: klKood, label_et: klNimetus}, value: {code: tenaId, label_et: nimetus}}`. Seen on
the residential building: load-bearing structures, floor slabs, roof covering and roof structure,
foundation, outer walls, heat source and heat supply, water supply, sewage, electricity. The
register's classifier lists 158 groups (`/api/av/v2/params/tehnakl`). The indicators of
single parts (`ehitiseOsaTehnilisedNaitajad`) are not taken in `ee/1`.

## `cadastral_units`

From `ehitiseKatastriyksused.ehitiseKatastriyksus[].katastritunnus`.

## For the core (plugin methods, epic E12 section 2a)
- **Apartment list for the setup wizard (X3):** `units` with `kind == APARTMENT`: number and area.
- **Certificate reminder (X2):** the newest valid certificate's `valid_until`.
