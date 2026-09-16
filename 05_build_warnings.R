library(tidyverse)
library(sf)
library(jsonlite)

source(here::here("00_paths.R"))

# Fire Warnings ----------------------------------------------------------------
# Keeps the Fire Warnings that name an Oklahoma county or zone, and gives each a
# shape, an expiry and a summary:
#
#   warnings.geojson       one feature per warning, for the map and the list
#   warning_text.json      full product text by id, fetched only when a reader
#                          opens a warning
#
# Shape comes from the warning's own LAT...LON polygon where it has one - every
# warning since 2022 and some from 2017 and 2019 - and otherwise from the
# counties its UGC line names. The polygon is in the text itself, so IEM's
# separate shapefile archive, which starts in 2022, is not needed.
#
# Writes outputs/05_warnings/. Run after 04, whose simplified county outlines
# it reuses so warning edges sit on the county lines the map draws.

out <- file.path(outputs, "05_warnings")
map_data <- file.path(outputs, "04_map_data")

files <- list.files(warnings_dir, pattern = "\\.txt$", full.names = TRUE)
if (length(files) == 0) {
  stop("No warnings at ", warnings_dir, " - run 02_refresh_warnings.R first.")
}

if (!file.exists(file.path(map_data, "counties.geojson"))) {
  stop("No county outlines - run 04_build_map_data.R first.")
}

# Offices that issue for Oklahoma. Declared, so a warning from any other office
# naming Oklahoma stops the build rather than appearing unlabeled.
offices <- tribble(
  ~office, ~office_name,
  "OUN",   "NWS Norman",
  "TSA",   "NWS Tulsa",
  "AMA",   "NWS Amarillo",
  "SHV",   "NWS Shreveport"
)

# Read -------------------------------------------------------------------------
# The UGC block can wrap across lines and ends at its ddhhmm purge time.
ugc_pattern <- "(?m)^([A-Z]{2}[CZ]\\d{3}[0-9A-Z>\\s-]*?\\d{6}-)"

# Some products still carry raw WMO framing: SOH and ETX bytes, CR line ends.
products <- tibble(file = files) |>
  mutate(
    text = map_chr(file, read_file) |> str_remove_all("[\001\003\r]"),
    product_id = basename(file) |>
      str_remove("\\.txt$") |>
      str_remove_all(" "),
    issue_utc = ymd_hm(str_extract(product_id, "\\d{12}"), tz = "UTC"),
    office = str_match(text, "(?m)^[A-Z]{4}\\d{2}\\s+K([A-Z]{3})\\s")[, 2],
    ugc_block = str_match(text, ugc_pattern)[, 2]
  )

no_ugc <- filter(products, is.na(ugc_block) | is.na(issue_utc))
if (nrow(no_ugc) > 0) {
  print(select(no_ugc, product_id, office))
  stop("Products above have no readable UGC line or issue time.")
}

# UGC --------------------------------------------------------------------------
# "OKZ004>007-010-OKC015-150300-": a code carries its state and type forward to
# the bare numbers after it, > is an inclusive range, and the last token is the
# purge time. Returns the expanded codes and the purge token, or NA codes when a
# token does not parse.
parse_ugc <- function(block) {
  tokens <- str_split(str_remove_all(block, "\\s"), "-")[[1]]
  tokens <- tokens[tokens != ""]
  purge <- tokens[length(tokens)]
  prefix <- NA_character_
  codes <- character()

  for (token in head(tokens, -1)) {
    m <- str_match(token, "^([A-Z]{2}[CZ])?(\\d{3})(?:>(\\d{3}))?$")
    if (is.na(m[1, 1]) || (is.na(m[1, 2]) && is.na(prefix))) {
      return(list(codes = NA_character_, purge = purge))
    }
    if (!is.na(m[1, 2])) prefix <- m[1, 2]
    from <- as.integer(m[1, 3])
    to <- if (is.na(m[1, 4])) from else as.integer(m[1, 4])
    codes <- c(codes, sprintf("%s%03d", prefix, from:to))
  }

  list(codes = codes, purge = purge)
}

products <- products |>
  mutate(
    ugc = map(ugc_block, parse_ugc),
    codes = map(ugc, "codes"),
    purge = map_chr(ugc, "purge")
  )

bad_ugc <- products |>
  filter(map_lgl(codes, \(x) anyNA(x)))

if (nrow(bad_ugc) > 0) {
  print(select(bad_ugc, product_id, ugc_block))
  stop("Products above have a UGC line that does not parse.")
}

warnings <- products |>
  filter(map_lgl(codes, \(x) any(str_starts(x, "OK"))))

message("Oklahoma: ", nrow(warnings), " of ", nrow(products), " Fire Warnings")

unknown_office <- warnings |>
  anti_join(offices, by = "office")

if (nrow(unknown_office) > 0) {
  print(select(unknown_office, product_id, office))
  stop("Offices above are not declared in this script.")
}

# Expiry -----------------------------------------------------------------------
# The purge time gives day, hour and minute only. It takes the issue month, or
# the next month when that would fall before the issue time.
warnings <- warnings |>
  mutate(
    expire_utc = make_datetime(
      year(issue_utc), month(issue_utc),
      as.integer(str_sub(purge, 1, 2)),
      as.integer(str_sub(purge, 3, 4)),
      as.integer(str_sub(purge, 5, 6)),
      tz = "UTC"
    ),
    expire_utc = if_else(
      expire_utc < issue_utc - hours(1),
      expire_utc %m+% months(1),
      expire_utc
    )
  )

bad_expiry <- warnings |>
  filter(
    is.na(expire_utc) |
      expire_utc < issue_utc |
      expire_utc > issue_utc + days(2)
  )

if (nrow(bad_expiry) > 0) {
  print(select(bad_expiry, product_id, issue_utc, purge, expire_utc))
  stop("Warnings above expire before issue or more than two days after.")
}

# Counties ---------------------------------------------------------------------
# County codes are FIPS; zone codes go through the NWS zone-county file. Every
# Oklahoma code must resolve, or a warning would lose part of its area.
counties <- st_read(file.path(map_data, "counties.geojson"), quiet = TRUE)

zones <- read_csv(zone_county_reference, col_types = cols(.default = "c"))

areas <- warnings |>
  select(product_id, codes) |>
  unnest(codes) |>
  filter(str_starts(codes, "OK")) |>
  distinct() |>
  mutate(
    county_fips = if_else(
      str_sub(codes, 3, 3) == "C",
      paste0("40", str_sub(codes, 4, 6)),
      NA_character_
    )
  ) |>
  left_join(select(zones, ugc, fips), by = c("codes" = "ugc")) |>
  mutate(geoid = coalesce(county_fips, fips)) |>
  left_join(st_drop_geometry(counties), by = "geoid")

unresolved <- filter(areas, is.na(county))
if (nrow(unresolved) > 0) {
  print(unresolved)
  stop("UGC codes above match no Oklahoma county or zone.")
}

# Zone numbers change: Osage, Sequoyah and Le Flore were split between the 2025
# and 2026 files. A reused number would put an old warning in the wrong county
# without any code failing. A warning with a polygon is checked against it
# below; one without must name at least one of its counties. County codes are
# FIPS and cannot be misread this way; their texts often name only towns
# (Guymon, not Texas County).
squash <- \(x) str_to_upper(str_remove_all(x, "[^A-Za-z]"))

name_check <- areas |>
  filter(str_sub(codes, 3, 3) == "Z") |>
  left_join(select(warnings, product_id, text), by = "product_id") |>
  filter(!str_detect(text, "LAT\\.\\.\\.LON")) |>
  mutate(named = str_detect(squash(text), fixed(squash(name)))) |>
  summarise(
    named = any(named),
    zones = paste(codes, collapse = " "),
    .by = product_id
  ) |>
  filter(!named)

if (nrow(name_check) > 0) {
  print(name_check)
  stop("Zone-coded warnings above have no polygon and name none of the ",
       "counties their zones resolve to.")
}

area_lists <- areas |>
  arrange(product_id, county) |>
  summarise(
    county_ids = paste(unique(county), collapse = ","),
    county_names = paste(unique(name), collapse = ", "),
    .by = product_id
  )

# Polygons ---------------------------------------------------------------------
# LAT...LON pairs in hundredths of a degree, longitude west and written without
# its sign; five digits past 100 degrees.
parse_polygon <- function(text) {
  body <- str_match(text, "LAT\\.\\.\\.LON((?:\\s+\\d{4,5})+)")[1, 2]
  if (is.na(body)) return(NULL)
  v <- as.numeric(str_extract_all(body, "\\d+")[[1]])
  if (length(v) %% 2 != 0 || length(v) < 6) return("bad")
  xy <- cbind(-v[c(FALSE, TRUE)] / 100, v[c(TRUE, FALSE)] / 100)
  rbind(xy, xy[1, ])
}

warnings <- warnings |>
  mutate(ring = map(text, parse_polygon))

bad_polygons <- warnings |>
  filter(map_lgl(ring, \(r) {
    identical(r, "bad") ||
      (is.matrix(r) && (any(r[, 1] < -104 | r[, 1] > -93) ||
                          any(r[, 2] < 33 | r[, 2] > 38)))
  }))

if (nrow(bad_polygons) > 0) {
  print(select(bad_polygons, product_id))
  stop("Warnings above have a LAT...LON polygon that is malformed or not ",
       "in Oklahoma.")
}

sf_use_s2(FALSE)

county_union <- function(ids) {
  counties |>
    filter(county %in% as.integer(str_split(ids, ",")[[1]])) |>
    st_union() |>
    st_geometry()
}

warnings <- warnings |>
  left_join(area_lists, by = "product_id") |>
  mutate(
    has_polygon = map_lgl(ring, is.matrix),
    geometry = map2(ring, county_ids, \(r, ids) {
      if (is.matrix(r)) st_make_valid(st_sfc(st_polygon(list(r))))[[1]]
      else county_union(ids)[[1]]
    }) |>
      st_sfc(crs = 4326)
  ) |>
  st_as_sf()

# A warning's polygon must overlap at least one county its UGC line names. This
# is the check that a zone number resolved to the right place.
misplaced <- warnings |>
  filter(has_polygon) |>
  mutate(
    overlaps = map2_lgl(geometry, county_ids, \(g, ids) {
      polygon <- st_sfc(g, crs = 4326)
      any(st_intersects(polygon, county_union(ids), sparse = FALSE))
    })
  ) |>
  filter(!overlaps)

if (nrow(misplaced) > 0) {
  print(select(st_drop_geometry(misplaced), product_id, county_names))
  stop("Warnings above have a polygon outside every county they name.")
}

# Text -------------------------------------------------------------------------
# Who asked for the warning, and what the message says. Older products put the
# agency after "at the request of" and open with a line saying a message
# follows, so that line is skipped. Products written in capitals are left that
# way rather than guessed into sentence case.
summary_of <- function(text) {
  paragraphs <- str_split(text, "\\n\\s*\\n")[[1]] |> str_squish()
  stamp <- str_which(
    paragraphs,
    "(?i)\\d{3,4} [AP]M [A-Z]{3} [A-Z]{3} [A-Z]{3} \\d{1,2} \\d{4}"
  )
  if (length(stamp) == 0) return(NA_character_)
  body <- paragraphs[-seq_len(stamp[1])]
  body <- body[body != "" & !str_detect(body, "(?i)^THE FOLLOWING MESSAGE IS")]
  if (length(body) == 0 || str_detect(body[1], "^(&&|\\$\\$|PRECAUTIONARY)")) {
    return(NA_character_)
  }
  # "The National Weather Service has issued..." is followed by bulleted
  # detail; the first bullet is where the fire is.
  if (length(body) > 1 && str_starts(body[2], fixed("*"))) {
    return(paste(body[1], body[2]))
  }
  body[1]
}

title_if_caps <- function(x) {
  if_else(!is.na(x) & !str_detect(x, "[a-z]"), str_to_title(x), x)
}

requested_pattern <- "(?i)REQUESTED BY (.+?) (?:RELAYED BY|\\d{3,4} [AP]M )"
request_pattern <- "(?i)AT THE REQUEST OF (?:THE )?(?:LOCAL )?(.+?)\\."

warnings <- warnings |>
  mutate(
    flat = str_squish(text),
    requested_by = coalesce(
      str_match(flat, requested_pattern)[, 2],
      str_match(flat, request_pattern)[, 2]
    ),
    requested_by = title_if_caps(requested_by),
    summary = map_chr(text, summary_of),
    local_start = as.Date(issue_utc, tz = local_tz),
    local_end = as.Date(expire_utc, tz = local_tz)
  ) |>
  left_join(offices, by = "office") |>
  filter(local_end >= archive_start) |>
  arrange(issue_utc)

no_summary <- filter(warnings, is.na(summary))
if (nrow(no_summary) > 0) {
  print(select(st_drop_geometry(no_summary), product_id))
  stop("Warnings above have no paragraph after the issue time to summarise.")
}

message(
  "Warnings since ", archive_start, ": ", nrow(warnings), ", ",
  sum(warnings$has_polygon), " with their own polygon, ",
  sum(!warnings$has_polygon), " drawn as whole counties"
)

# Write ------------------------------------------------------------------------
unlink(out, recursive = TRUE)
dir.create(out, recursive = TRUE)

# Times as minutes since 1970 UTC and days as the detection chunks count them,
# so the browser compares warnings and detections on the same scales.
warnings |>
  transmute(
    id = product_id,
    t0 = as.integer(as.numeric(issue_utc) %/% 60),
    t1 = as.integer(as.numeric(expire_utc) %/% 60),
    d0 = as.integer(local_start - archive_start),
    d1 = as.integer(local_end - archive_start),
    office_name,
    requested_by,
    summary,
    polygon = has_polygon,
    counties = county_ids,
    county_names,
    url = paste0(
      "https://mesonet.agron.iastate.edu/wx/afos/p.php?pil=FRW", office,
      "&e=", format(issue_utc, "%Y%m%d%H%M")
    )
  ) |>
  st_write(
    file.path(out, "warnings.geojson"),
    quiet = TRUE,
    layer_options = c("COORDINATE_PRECISION=4", "RFC7946=YES")
  )

warnings |>
  st_drop_geometry() |>
  select(product_id, text) |>
  deframe() |>
  as.list() |>
  write_json(file.path(out, "warning_text.json"), auto_unbox = TRUE)
