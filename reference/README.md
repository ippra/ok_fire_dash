# reference/

Small hand-maintained tables the build reads. `02_build_map_data.R` stops if
NOAA uses a satellite or method name that is not listed here, so a new name is
added on purpose rather than guessed.

| file | what it is | source |
|---|---|---|
| `satellites.csv` | NOAA's raw `Satellite` values and the name shown on the dashboard | read off the HMS daily text files, 2015-2026 |
| `methods.csv` | NOAA's raw `Method` values and the sensor family each belongs to | read off the HMS daily text files, 2015-2026; algorithm notes from https://www.ospo.noaa.gov/Products/land/hms.html |
| `undatable_rows.csv` | NOAA files holding rows whose `YearDay` is not a date, with the count expected in each; those rows are dropped, and any other unparseable row stops the build | found by the build's own guard, 2026-09-16 |
| `ok_counties_2023.geojson` | Oklahoma's 77 counties, full resolution, used to assign each detection its county | Census cartographic boundary file, 2023, via `tigris::counties(state = "OK", cb = TRUE, year = 2023)` |

`MetOp-02` is kept as NOAA wrote it rather than mapped to MetOp-A or MetOp-B:
the files use `METOP-02` and `METOP-A` in different years, and nothing in them
says whether they are the same satellite.
