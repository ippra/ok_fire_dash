# Paths ------------------------------------------------------------------------
# Every script sources this so data locations are defined once. The project is
# self-contained: the raw archive is rebuilt from NOAA by 01_refresh_data.R and
# lives under data/, which is gitignored, so nothing here needs configuring on a
# new machine.

project_root <- here::here()

data_dir <- file.path(project_root, "data")
reference_dir <- file.path(project_root, "reference")
site_src <- file.path(project_root, "site")
outputs <- file.path(project_root, "outputs")

# One CSV per NOAA daily file, cropped to the Oklahoma bounding box. Days NOAA
# never published are listed once so a refresh stops asking for them.
archive_dir <- file.path(data_dir, "hms_text")
unavailable_file <- file.path(archive_dir, "unavailable_days.csv")
truncated_file <- file.path(archive_dir, "truncated_days.csv")

# Source -----------------------------------------------------------------------
# NOAA Hazard Mapping System fire points, daily text product:
# https://www.ospo.noaa.gov/Products/land/hms.html
# Daily text files exist from 2003. The shapefile annual bundles are the same
# product but a different vintage and disagree on some days - in the Oklahoma
# box, 2024-04-08 has 717 detections in the text files and 729 in the bundle,
# 2018-07-15 has 51 and 18 - so the archive is built from the text files alone.
hms_text_url <- paste0(
  "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Fire_Points/Text/"
)

# The dashboard's first day. The original map started here; moving it earlier
# is this one line plus a longer first refresh.
archive_start <- as.Date("2015-01-01")

# NOAA revises a day's file after it first appears - the current day's file
# grows until the next morning, and analysts add and delete points - so every
# refresh re-fetches this many recent days whether or not they are on disk.
lookback_days <- 5

# NWS Fire Warnings (FRW), every office, from the Iowa Environmental Mesonet's
# text archive. Re-pulled in full each refresh: since 2015 it is about 430 KB
# and a fraction of a second, so there is no local state to drift, and a
# correction IEM has received replaces the original.
# https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py
warnings_dir <- file.path(data_dir, "frw_text")
frw_url <- "https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py"

# Oklahoma's extent is -103.00 to -94.43 and 33.62 to 37.00. The crop keeps a
# margin so no border detection is lost before 03 clips to the state itself.
crop_box <- c(xmin = -103.1, xmax = -94.3, ymin = 33.5, ymax = 37.1)

# Detections are dated by the Oklahoma calendar day they occurred on. NOAA's
# timestamps are UTC, and an evening fire in Oklahoma is the next UTC day.
local_tz <- "America/Chicago"

# Reference Tables -------------------------------------------------------------
satellites_reference <- file.path(reference_dir, "satellites.csv")
methods_reference <- file.path(reference_dir, "methods.csv")
undatable_reference <- file.path(reference_dir, "undatable_rows.csv")

# Which county each Oklahoma public forecast zone covers, for warnings that name
# zones. NWS zone-county correlation files of 18 March 2025 and 16 April 2026,
# combined: between them NWS Tulsa split the Osage, Sequoyah and Le Flore zones
# (054, 072, 076) into 154-354, 172-272 and 176-376, and warnings up to
# February 2026 still use the old numbers. No number is reused.
# https://www.weather.gov/gis/ZoneCounty
zone_county_reference <- file.path(reference_dir, "ok_zone_county.csv")

# Counties come from the Census cartographic boundary file, 2023 vintage, via
# tigris::counties(cb = TRUE). Cached here so a build needs no network.
counties_file <- file.path(reference_dir, "ok_counties_2023.geojson")
