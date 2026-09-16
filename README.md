# ok_fire_dash - Oklahoma Fire Detections

A static site that maps every satellite fire detection in Oklahoma since
2015 from NOAA's Hazard Mapping System (HMS), and every National Weather
Service Fire Warning issued for Oklahoma, for any range of dates, and updates
itself as new data are published.

It replaces `NOAA FIRE DATA/ok_fire_map/fire_map.R`, which baked the whole
archive into a 280 MB htmlwidget and could show one day at a time. This site
loads only the dates you ask for, so a first visit downloads about 2 MB.

## What it does

- **Any date range.** Presets (latest day, 7, 30 and 90 days, year to date,
  12 months, all years, any single year), date fields, and a timeline of
  detections across the whole archive that you drag to select. The arrow
  buttons and arrow keys move the range by its own length, so a single day
  steps a day and a week steps a week.
- **Play minute by minute** through the selected range: a clock in Central
  Time advances 1, 5 or 15 minutes or an hour per frame, and the map shows the
  detections from the hour before it, older ones fading.
- **Three views.** Individual detections, colored by fire intensity or by
  sensor; a heat map of density; and counties shaded by detections per 100
  square miles.
- **Four base maps:** dark, light, streets and satellite imagery.
- **Fire warnings.** NWS Fire Warnings in force during the selected dates are
  outlined in violet - the warning's own polygon, or a dashed whole-county
  outline for older warnings issued without one. A panel lists them, a tile
  counts them, the timeline marks each one, and clicking one gives the time,
  counties, requesting agency, the NWS summary and the full text.
- **Filters** by sensor (GOES, VIIRS, MODIS, AVHRR, analyst-added) and minimum
  intensity. Every number on the page follows the filters.
- **Summary** of the period: detections, days with detections, the busiest
  day, the most intense detection, and a ranked county list. Each links to the
  map.
- **Share and export.** The address bar always holds the current view, so a
  copied link reproduces it; links to a preset like "30 days" stay current.
  Save the map as a PNG with a title and credits, or download the selected
  detections as CSV.
- **Updates itself.** A GitHub Actions workflow refreshes from NOAA every three
  hours, and an open page checks for new data every 10 minutes and loads it
  without a reload.

## The pipeline

Scripts run in number order. Each sources `00_paths.R`, which resolves paths
against the project root, so nothing is machine-specific.

| step | what it is |
|---|---|
| `00_run_pipeline.R` | runs 01-05; the entry point for a scheduled update |
| `01_refresh_data.R` | tops up `data/hms_text/` from NOAA's daily text files. **Incremental**: fetches days not on disk plus the last 5, which NOAA is still revising. Downloads run one at a time: NOAA's server stalled every parallel transfer R attempted |
| `02_refresh_warnings.R` | re-pulls every NWS Fire Warning since 2015 from the Iowa Environmental Mesonet into `data/frw_text/`: about 430 KB, under a second, so no incremental state |
| `03_build_map_data.R` | clips to Oklahoma, assigns county and local day, writes binary detection chunks, the manifest and county outlines → `outputs/03_map_data/` |
| `04_build_warnings.R` | keeps Oklahoma's warnings, parses their areas, polygons, expiry and summary → `outputs/04_warnings/` |
| `05_build_dashboard.R` | copies `site/`, the map data and the warnings into one static directory → `outputs/05_site/` |

```
NOAA HMS daily text files           IEM Fire Warning text archive
        │                                   │
01_refresh_data.R                   02_refresh_warnings.R
        │   cold start ~40 min,             │   full pull, under a second
        │   routine refresh seconds         │
data/hms_text/                      data/frw_text/
        │                                   │
        │   reference/ satellites,          │   reference/ok_zone_county.csv
        │   methods, counties               │
        ▼                                   │
03_build_map_data.R  ─── counties ────────► 04_build_warnings.R
        │   about 15 seconds                │   seconds
        ▼                                   ▼
outputs/03_map_data/                outputs/04_warnings/
        │                                   │
        └──────────────┬────────────────────┘
                       │   site/ (front end source)
                       ▼
             05_build_dashboard.R           seconds
                       │
             outputs/05_site/               the deployable site
```

## Building and previewing

```sh
Rscript 00_run_pipeline.R     # refresh, build data, assemble site
python3 preview.py            # http://localhost:8902
```

R packages: `tidyverse`, `sf`, `jsonlite`, `curl`, `here`, `rmapshaper`.
`tigris` only to regenerate the county file.

Every script stops loudly instead of producing a quietly wrong site: a NOAA
file that reads short, a day missing from the archive, a satellite or method
name not in `reference/`, a negative intensity that is not NOAA's -999 code, a
county join that changes the row count, a chunk the manifest lists but the disk
lacks, a warning whose UGC line, expiry or polygon does not parse or whose zone
resolves to no county, and R or CSV files in the published directory all halt
the build. A
failed run leaves the last good site in place.

## Decisions worth knowing

**Daily text files, not the annual shapefile bundles.** The two are different
vintages of the same product and disagree on some days (in the Oklahoma box,
2024-04-08 has 717 detections in the text files and 729 in the bundle;
2018-07-15 has 51 and 18). One source keeps the archive and its daily top-up
consistent.

**NOAA's files do not follow calendar days.** Each daily file runs into the
early UTC hours of the next day. Detections are dated by their own timestamp,
converted to Oklahoma time, so an evening fire belongs to the day it burned.

**NOAA sometimes publishes a file cut off mid-record.** The file for
2025-05-08 ends in `NOAA 21, VI` with no newline, and `readr` silently drops
that line. The refresh checks each file's row count against its line count,
recognizes a cut-off file by its missing final newline, keeps the rows before
the cut, and records the day in `truncated_days.csv`. The dashboard says so
for any period that includes one. A later fetch that comes back complete
clears the record.

**-999 is not an intensity.** NOAA writes -999 where fire radiative power was
not measured - every analyst-added and AVHRR point and roughly a third of GOES
points. The old map printed it as "-999 MW (Low)". Here it is "not measured",
drawn in gray and excluded by any minimum-intensity filter.

**Names drift.** NOAA's GOES method is `ABBA` before 2018, `FDC` after, `NGFS`
from 2026; the same satellite is `SUOMI NPP` in the text files and `S-NPP` in
the bundles; `GOES-WEST` and `GOES-West` both occur. `reference/` maps each raw
name, and a new one stops the build.

**Counts reflect satellites as much as fire.** GOES-16's five-minute scans from
2018, and NOAA-20 (2018) and NOAA-21 (2023) joining VIIRS, each raised
detection counts. VIIRS points enter NOAA's files in 2016-2017; from then on,
VIIRS alone is the most consistent series, so the sensors panel has a one-click
"VIIRS only" for comparing years, and the About section says why.

**Counties are shaded by rate.** Detections per 100 square miles, in quintile
breaks of the counties with any detections. Raw counts mostly measure county
size.

**Individual points up to 150,000.** Above that the map switches to the heat
map and says so; the GeoJSON hand-off to MapLibre takes seconds beyond it.

**Fire Warnings come from their own text.** Every Oklahoma warning since 2022,
and some from 2017 and 2019, carries a `LAT...LON` polygon in the product, 134
of the 159 since 2015. That is more than IEM's separate warning shapefiles
hold (they start in 2022), so the build parses the text and needs no
shapefile. The other 25 are drawn as the counties their UGC line names.

**Zone numbers change.** Between the NWS zone-county files of March 2025 and
April 2026, NWS Tulsa split the Osage, Sequoyah and Le Flore zones (054, 072,
076) into 154/254/354, 172/272 and 176/276/376, and warnings up to February
2026 still use the old numbers. `reference/ok_zone_county.csv` combines both
files; no number was reused. Because a reused number would silently move an
old warning, the build checks each zone-coded warning against its evidence: a
polygon must overlap one of its counties, and a warning without one must name
one in its text.

**A warning belongs to a day it was in force.** A warning appears for any
selected date between the Oklahoma day it was issued and the day it expired,
so an evening warning running past midnight shows on both days. During
playback the map shows only the warnings in force at the clock.

## Data format

`03_build_map_data.R` writes one binary chunk per past year and per month of
the current year, so a daily refresh rewrites a small file and browsers keep
the rest cached. Each file name carries a content hash, so any file can be
cached forever. A chunk is columnar, little-endian, 20 bytes per detection:

| bytes | column |
|---|---|
| float32 | longitude |
| float32 | latitude |
| float32 | FRP in MW, NaN when not measured |
| uint32 | minutes since 1970-01-01 UTC |
| uint16 | Oklahoma day, counted from 2015-01-01 |
| uint8 | source (satellite, method, family) - index into the manifest |
| uint8 | county - 1-based index into the manifest |

`manifest.json` carries the chunk list, vocabularies, counties, the daily
count series per sensor family behind the timeline, and the build stamps.

## The front end

`site/` is hand-edited: `index.html`, `engine.js`, `engine.css`, and MapLibre
GL JS 6.10.0 vendored under `site/assets/vendor/`. The IPPRA bar is the same
markup as fusion_dash's.

Colors were checked with the dataviz palette validator against each base map's
own background. Intensity is one orange hue in four steps, ordered so the
strongest fires have the most contrast with the map: brightest on dark maps,
darkest on light ones. Sensor colors use three categorical slots, the most
that stay distinguishable on a map, so MODIS, AVHRR and analyst-added points
share the third.

Fire warnings are outlined in violet, the categorical slot farthest from every
orange intensity step on both base maps (OKLab distance of 24 or more for
every vision type checked). Its one close neighbor is the GOES blue in
"color by sensor" mode, where the shapes differ: warnings are outlines,
detections are dots.

The only third-party requests are base map tiles: CARTO for the vector maps
and labels, Esri for satellite imagery. If they fail, the county and state
lines and every detection still draw.

## Automatic updates: GitHub Actions and Pages

`.github/workflows/refresh.yml` runs `00_run_pipeline.R` every three hours
(and on every push to `main` or by hand from the Actions tab) and publishes
`outputs/05_site/` to GitHub Pages. No computer needs to be on.

The raw archive is not committed. It lives in the Actions cache between runs,
so a routine run fetches only the last few days from NOAA and finishes in a
few minutes. If the cache is evicted, the first run rebuilds it from NOAA in
about 40 minutes and saves it again.

A failed run publishes nothing, so the live site keeps its last good build,
and GitHub emails the repository owner. Usual causes: NOAA's server is down
(the next run retries), or NOAA used a satellite or method name that is not
in `reference/` - add the row and push.

Open pages also update themselves: the page re-reads `data/manifest.json`
every 10 minutes and loads new detections without a reload.

### One-time setup

1. Create an empty **public** repository on GitHub (for example
   `ippra/ok_fire_dash`). Pages on a private repository needs a paid plan.
2. Push this directory:

   ```sh
   git add -A
   git commit -m "Oklahoma fire detections dashboard"
   git branch -M main
   git remote add origin https://github.com/<owner>/ok_fire_dash.git
   git push -u origin main
   ```

3. In the repository, **Settings → Pages → Source: GitHub Actions**.
4. **Actions → Refresh and publish → Run workflow**, or wait for the push to
   trigger it. The first run takes about 45 minutes; the site is then at
   `https://<owner>.github.io/ok_fire_dash/`.

GitHub disables scheduled workflows in a public repository after 60 days
without a commit. The Actions tab shows a banner with a button to re-enable
it.

## Hosting elsewhere

`outputs/05_site/` is the whole site: plain static files, no server code, so it
can also be copied to ippra.net like the other dashboards.

- `index.html` must be served with `Cache-Control: no-cache`. It is the one
  file that cannot version-stamp itself.
- `engine.js` and `engine.css` carry a `?v=<build>` stamp, and detection chunks
  carry a content hash, so both can be cached as long as a host likes.
- `data/manifest.json` is fetched with `no-store` and a query string.

`05_build_dashboard.R` builds into `outputs/05_site.next` and swaps it in, so a
host serving `outputs/05_site` never sees a half-copied site mid-refresh.
