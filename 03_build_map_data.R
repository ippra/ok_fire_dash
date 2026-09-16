library(tidyverse)
library(sf)
library(jsonlite)

source(here::here("00_paths.R"))

# Map Data ---------------------------------------------------------------------
# Reads the raw archive, clips it to Oklahoma, assigns each detection its
# county and Oklahoma calendar day, and writes what the browser loads:
#
#   manifest.json      counts, vocabularies, the chunk list, and the daily
#                      series behind the timeline
#   fires_<id>_<hash>.bin
#                      the detections themselves, one file per past year and
#                      one per month of the current year
#   counties.geojson   simplified county outlines for display
#
# Every number the dashboard shows is either in the manifest or counted in the
# browser from these rows, so the timeline and the map cannot disagree.
#
# Writes outputs/03_map_data/, rebuilt from scratch each run.

out <- file.path(outputs, "03_map_data")

# Archive Coverage -------------------------------------------------------------
# Checked before reading: a day missing from disk would be drawn as a day
# without fire, which is indistinguishable from the real thing on a map.
archive_files <- list.files(
  archive_dir,
  pattern = "^hms_fire\\d{8}\\.csv$",
  recursive = TRUE,
  full.names = TRUE
)

if (length(archive_files) == 0) {
  stop("No archive at ", archive_dir, " - run 01_refresh_data.R first.")
}

file_days <- as.Date(str_extract(basename(archive_files), "\\d{8}"), "%Y%m%d")

unavailable <- if (file.exists(unavailable_file)) {
  read_csv(unavailable_file, col_types = cols(day = col_date()))
} else {
  tibble(day = as.Date(character()))
}

truncated <- if (file.exists(truncated_file)) {
  read_csv(truncated_file, col_types = cols(day = col_date()))
} else {
  tibble(day = as.Date(character()))
}

expected_days <- seq(archive_start, max(file_days), by = "day")
gaps <- expected_days[!expected_days %in% c(file_days, unavailable$day)]

message(
  "Archive: ", length(archive_files), " daily files, ",
  nrow(unavailable), " days NOAA never published, ", nrow(truncated),
  " cut off, ", length(gaps), " gaps"
)

if (length(gaps) > 0) {
  print(gaps)
  stop("Days above are missing from the archive - run 01_refresh_data.R.")
}

# Read -------------------------------------------------------------------------
raw <- read_csv(
  archive_files,
  col_types = cols(.default = col_character()),
  id = "file",
  progress = FALSE
)

detections <- raw |>
  transmute(
    lon = as.numeric(Lon),
    lat = as.numeric(Lat),
    utc = as.POSIXct(paste(YearDay, Time), format = "%Y%j %H%M", tz = "UTC"),
    satellite_raw = Satellite,
    method_raw = Method,
    frp = as.numeric(FRP)
  )

# Twenty analyst-added rows in two 2015-2016 files carry a clock time where the
# year and day belong, so they cannot be placed on a date. They are declared in
# reference/undatable_rows.csv with their count and dropped; any other row that
# fails to parse, or a changed count in those files, stops the build.
undatable <- read_csv(
  undatable_reference,
  col_types = cols(file = "c", rows = "i", reason = "c")
)

unparsed <- raw |>
  mutate(file = basename(file), row = row_number()) |>
  filter(is.na(detections$lon) | is.na(detections$lat) | is.na(detections$utc))

unparsed_counts <- unparsed |>
  count(file, name = "found") |>
  full_join(undatable, by = "file") |>
  filter(is.na(rows) | is.na(found) | found != rows)

if (nrow(unparsed_counts) > 0) {
  print(unparsed_counts)
  print(filter(unparsed, file %in% unparsed_counts$file))
  stop("Rows above have an unreadable position or timestamp that ",
       "reference/undatable_rows.csv does not declare.")
}

message("Undatable: ", nrow(unparsed), " declared rows dropped")
detections <- detections[-unparsed$row, ]

# FRP Sentinel -----------------------------------------------------------------
# NOAA writes -999 where a detection carries no fire radiative power: every
# analyst-added point, every AVHRR point, and about a third of GOES points. Left
# in, it averages to a negative fire and sorts below every real one.
bad_frp <- detections |>
  filter(frp < 0 & frp != -999)

if (nrow(bad_frp) > 0) {
  print(bad_frp)
  stop("Rows above have a negative FRP that is not the -999 sentinel.")
}

message(
  "FRP: ", sum(detections$frp == -999, na.rm = TRUE), " of ",
  nrow(detections), " detections carry the -999 sentinel"
)

detections <- detections |>
  mutate(frp = if_else(frp == -999, NA_real_, frp))

n_read <- nrow(detections)
detections <- distinct(detections)
message("Duplicates: ", n_read - nrow(detections), " removed")

# Vocabularies -----------------------------------------------------------------
# NOAA has renamed both fields over time: the GOES method is ABBA before 2018,
# FDC after and NGFS from 2026, and GOES-WEST also appears as GOES-West.
# Declared in reference/ rather than pattern-matched, so a new name stops the
# build instead of landing in the wrong family.
satellites <- read_csv(satellites_reference, col_types = cols(.default = "c"))
methods <- read_csv(methods_reference, col_types = cols(.default = "c"))

families <- tribble(
  ~family,   ~label,             ~description,
  "goes",    "GOES",             "Geostationary, scans every few minutes",
  "viirs",   "VIIRS",            "Polar-orbiting, 375 m pixels",
  "modis",   "MODIS",            "Polar-orbiting, 1 km pixels",
  "avhrr",   "AVHRR",            "Polar-orbiting, 1 km pixels, no FRP",
  "analyst", "Analyst-added",    "Placed by a NOAA analyst, no FRP"
)

unmatched_satellites <- detections |>
  distinct(satellite_raw) |>
  anti_join(satellites, by = "satellite_raw")

unmatched_methods <- detections |>
  distinct(method_raw) |>
  anti_join(methods, by = "method_raw")

if (nrow(unmatched_satellites) + nrow(unmatched_methods) > 0) {
  print(unmatched_satellites)
  print(unmatched_methods)
  stop("Names above are not in reference/satellites.csv or methods.csv.")
}

if (!all(methods$family %in% families$family)) {
  print(setdiff(methods$family, families$family))
  stop("Families above are in methods.csv but not declared in this script.")
}

detections <- detections |>
  left_join(satellites, by = "satellite_raw") |>
  left_join(methods, by = "method_raw")

# Counties ---------------------------------------------------------------------
# Planar point-in-polygon on longitude and latitude. At county scale the
# difference from spherical geometry is well under a metre, and s2 is several
# times slower on 700,000 points.
sf_use_s2(FALSE)

counties <- st_read(counties_file, quiet = TRUE) |>
  arrange(NAME) |>
  mutate(county = row_number())

points <- detections |>
  mutate(row = row_number()) |>
  st_as_sf(coords = c("lon", "lat"), crs = 4326, remove = FALSE)

joined <- points |>
  st_join(select(counties, county), join = st_intersects) |>
  st_drop_geometry()

# A detection exactly on a shared boundary matches both counties. It is one
# detection, so it keeps the first and the tie is reported.
message("County ties: ", nrow(joined) - nrow(points), " boundary points")
joined <- distinct(joined, row, .keep_all = TRUE)

if (nrow(joined) != nrow(points)) {
  stop("The county join changed the row count.")
}

message(
  "Oklahoma: ", sum(!is.na(joined$county)), " detections inside the state, ",
  sum(is.na(joined$county)), " in the crop margin dropped"
)

# Local Day --------------------------------------------------------------------
# The day index counts from archive_start in Oklahoma time. Detections from the
# first UTC hours of archive_start fall on the local day before it and are
# outside the archive.
fires <- joined |>
  filter(!is.na(county)) |>
  mutate(
    local_date = as.Date(utc, tz = local_tz),
    day = as.integer(local_date - archive_start)
  ) |>
  filter(day >= 0) |>
  arrange(utc)

sources <- fires |>
  distinct(satellite, method_raw, family) |>
  arrange(match(family, families$family), satellite, method_raw) |>
  mutate(source = row_number() - 1L)

fires <- fires |>
  left_join(sources, by = c("satellite", "method_raw", "family"))

if (nrow(sources) > 255) stop("More than 255 sources - they no longer fit.")

# Chunks -----------------------------------------------------------------------
# Past years are one file each and never change once the year is over. The
# current year is split by month, so a refresh rewrites a small file and a
# browser that already holds January does not fetch it again. The content hash
# in each name makes every file safe to cache forever.
#
# Layout, little-endian, n rows, column after column:
#   float32 lon | float32 lat | float32 frp (NaN = not measured)
#   uint32 minutes since 1970-01-01 UTC | uint16 day | uint8 source
#   uint8 county (1-based)
# Columnar rather than one record per row, so each column is a typed-array
# view on the buffer with no parsing, and the floats align on 4-byte offsets.
unlink(out, recursive = TRUE)
dir.create(out, recursive = TRUE)

current_year <- year(max(fires$local_date))

fires <- fires |>
  mutate(
    chunk = if_else(
      year(local_date) < current_year,
      format(local_date, "%Y"),
      format(local_date, "%Y-%m")
    )
  )

write_chunk <- function(rows, id) {
  tmp <- file.path(out, paste0(id, ".part"))
  con <- file(tmp, "wb")
  writeBin(rows$lon, con, size = 4, endian = "little")
  writeBin(rows$lat, con, size = 4, endian = "little")
  writeBin(rows$frp, con, size = 4, endian = "little")
  minutes <- as.integer(as.numeric(rows$utc) %/% 60)
  writeBin(minutes, con, size = 4, endian = "little")
  writeBin(rows$day, con, size = 2, endian = "little")
  writeBin(rows$source, con, size = 1, endian = "little")
  writeBin(rows$county, con, size = 1, endian = "little")
  close(con)

  if (file.size(tmp) != 20 * nrow(rows)) {
    stop("Chunk ", id, " is ", file.size(tmp), " bytes, not 20 per row.")
  }

  hash <- substr(unname(tools::md5sum(tmp)), 1, 10)
  file_name <- paste0("fires_", id, "_", hash, ".bin")
  file.rename(tmp, file.path(out, file_name))

  tibble(
    id = id,
    file = file_name,
    first_day = min(rows$day),
    last_day = max(rows$day),
    n = nrow(rows)
  )
}

chunks <- fires |>
  group_by(chunk) |>
  group_map(~ write_chunk(.x, .y$chunk)) |>
  bind_rows()

if (sum(chunks$n) != nrow(fires)) {
  stop("Chunks hold ", sum(chunks$n), " rows, not ", nrow(fires), ".")
}

# Daily Series -----------------------------------------------------------------
# Detections per Oklahoma day for each family, zeros included, so the timeline
# can draw the whole archive before any chunk has loaded.
latest_day <- max(fires$day)

daily <- fires |>
  count(family, day) |>
  complete(
    family = families$family,
    day = 0:latest_day,
    fill = list(n = 0L)
  ) |>
  arrange(family, day)

daily_series <- families$family |>
  set_names() |>
  map(\(f) daily$n[daily$family == f])

# County Outlines --------------------------------------------------------------
# Joined at full resolution above; simplified only for drawing.
# rmapshaper rather than st_simplify, which thins each county on its own and
# opens slivers between neighbours.
county_display <- counties |>
  rmapshaper::ms_simplify(keep = 0.08, keep_shapes = TRUE) |>
  transmute(county, name = NAME, geoid = GEOID)

st_write(
  county_display,
  file.path(out, "counties.geojson"),
  quiet = TRUE,
  layer_options = "COORDINATE_PRECISION=4"
)

# Dissolved from the simplified counties so the state line sits exactly on the
# county lines drawn beside it.
county_display |>
  rmapshaper::ms_dissolve() |>
  st_write(
    file.path(out, "state.geojson"),
    quiet = TRUE,
    layer_options = "COORDINATE_PRECISION=4"
  )

county_table <- counties |>
  mutate(bbox = map(geometry, \(g) round(as.numeric(st_bbox(g)), 4))) |>
  st_drop_geometry() |>
  transmute(
    id = county,
    geoid = GEOID,
    name = NAME,
    sq_mi = round(as.numeric(ALAND) / 2589988.11, 1),
    bbox
  )

# Manifest ---------------------------------------------------------------------
now_utc <- Sys.time()

manifest <- list(
  build = format(now_utc, "%Y%m%dT%H%M%SZ", tz = "UTC"),
  built_at = format(now_utc, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  data_through = format(max(fires$utc), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  newest_file_day = format(max(file_days)),
  epoch = format(archive_start),
  timezone = local_tz,
  latest_day = latest_day,
  total = nrow(fires),
  unavailable_days = I(format(unavailable$day)),
  truncated_days = I(format(truncated$day)),
  families = families,
  sources = transmute(sources, id = source, satellite, method = method_raw,
                      family),
  counties = county_table,
  chunks = chunks,
  daily = daily_series
)

write_json(
  manifest,
  file.path(out, "manifest.json"),
  auto_unbox = TRUE,
  dataframe = "rows",
  na = "null",
  digits = NA
)

message(
  "Map data: ", format(nrow(fires), big.mark = ","), " detections, ",
  nrow(chunks), " chunks, data through ", manifest$data_through
)
