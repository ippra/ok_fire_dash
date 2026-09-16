library(tidyverse)
library(sf)
library(xml2)

source(here::here("00_paths.R"))

# Wildfire WEAs ----------------------------------------------------------------
# Picks the Wireless Emergency Alerts about wildfire out of the Oklahoma IPAWS
# messages 03 keeps, and gives each a shape and a time in force:
#
#   weas.geojson     one feature per alert, for the map and the list
#
# A WEA is an Actual message carrying phone text (CMAMtext) or WEA handling.
# It is about wildfire when its event is Fire Warning, or when its phone text
# says wildfire. Every Oklahoma message that mentions fire in any other way
# must be listed in reference/wea_not_wildfire.csv, read and decided by hand,
# or the build stops: a new wording that the rule misses should be caught
# rather than dropped.
#
# Writes outputs/06_weas/. Run after 04, whose county outlines it reuses.

out <- file.path(outputs, "06_weas")
map_data <- file.path(outputs, "04_map_data")

if (!file.exists(weas_index)) {
  stop("No IPAWS archive - run 03_refresh_weas.R first.")
}

if (!file.exists(file.path(map_data, "counties.geojson"))) {
  stop("No county outlines - run 04_build_map_data.R first.")
}

index <- read_csv(weas_index, col_types = cols(.default = col_character()))

# Parse ------------------------------------------------------------------------
# CAP 1.2. Every Oklahoma wildfire WEA so far carries one English info block;
# the first is read, and a message with a second is reported below.
same_path <- "area/geocode[valueName='SAME']/value"

parse_message <- function(id) {
  doc <- read_xml(file.path(weas_dir, "messages", paste0(id, ".xml")))
  xml_ns_strip(doc)
  info <- xml_find_first(doc, "/alert/info")
  first_text <- \(node, path) xml_text(xml_find_first(node, path))
  param <- function(name) {
    path <- sprintf("parameter[valueName='%s']/value", name)
    values <- xml_text(xml_find_all(info, path))
    if (length(values) == 0) NA_character_ else paste(values, collapse = " ")
  }

  tibble(
    id = id,
    identifier = first_text(doc, "/alert/identifier"),
    sent = ymd_hms(first_text(doc, "/alert/sent"), quiet = TRUE),
    status = first_text(doc, "/alert/status"),
    msg_type = first_text(doc, "/alert/msgType"),
    references = first_text(doc, "/alert/references"),
    n_info = length(xml_find_all(doc, "/alert/info")),
    event = first_text(info, "event"),
    event_code = first_text(info, "eventCode[valueName='SAME']/value"),
    expires = ymd_hms(first_text(info, "expires"), quiet = TRUE),
    sender_name = first_text(info, "senderName"),
    phone = param("CMAMtext"),
    long = param("CMAMlongtext"),
    handling = param("WEAHandling"),
    polygons = list(xml_text(xml_find_all(info, "area/polygon"))),
    same = list(xml_text(xml_find_all(info, same_path)))
  )
}

messages <- map(index$id, parse_message) |>
  list_rbind()

unreadable <- filter(messages, is.na(sent) | is.na(msg_type))
if (nrow(unreadable) > 0) {
  print(select(unreadable, id, identifier))
  stop("Messages above have no readable sent time or message type.")
}

# Classify ---------------------------------------------------------------------
wildfire_words <- "(?i)wild\\s*(?:land\\s*)?fir|(?:grass|brush|forest)\\s*fire"
fire_words <- "(?i)\\bfires?\\b|\\bsmoke\\b|\\bburn(?:ing|ed)?\\b"

wea_candidates <- messages |>
  filter(
    status == "Actual",
    msg_type %in% c("Alert", "Update"),
    !is.na(phone) | !is.na(handling)
  ) |>
  mutate(
    text = paste(coalesce(phone, ""), coalesce(long, "")),
    wildfire = event_code %in% "FRW" | str_detect(text, wildfire_words)
  )

reviewed <- read_csv(
  wea_review_reference,
  col_types = cols(.default = col_character())
)

unreviewed <- wea_candidates |>
  filter(!wildfire, str_detect(text, fire_words)) |>
  anti_join(reviewed, by = "id")

if (nrow(unreviewed) > 0) {
  print(select(unreviewed, id, sent, event_code, phone), width = 200)
  stop("WEAs above mention fire but are not classed as wildfire. Read each ",
       "and add it to reference/wea_not_wildfire.csv, or widen the rule.")
}

weas <- filter(wea_candidates, wildfire)

multi_info <- filter(weas, n_info > 1)
if (nrow(multi_info) > 0) {
  message("WEAs with more than one info block, first used: ",
          paste(multi_info$id, collapse = ", "))
}

message("WEAs: ", nrow(wea_candidates), " Oklahoma WEAs, ", nrow(weas),
        " about wildfire")

# Time in Force ----------------------------------------------------------------
# An alert runs from sent to expires, unless a later Cancel or Update names it
# in its references ("sender,identifier,sent" triples), which ends it there.
bad_expiry <- weas |>
  filter(is.na(expires) | expires <= sent | expires > sent + days(1))

if (nrow(bad_expiry) > 0) {
  print(select(bad_expiry, id, sent, expires))
  stop("WEAs above have no expiry, or one before sending or a day after.")
}

followups <- messages |>
  filter(msg_type %in% c("Cancel", "Update"), !is.na(references)) |>
  mutate(ref = str_split(references, "\\s+")) |>
  unnest(ref) |>
  transmute(
    identifier = str_split_i(ref, ",", 2),
    followup_type = msg_type,
    followup_sent = sent
  ) |>
  filter(!is.na(identifier))

ends <- weas |>
  select(id, identifier, sent) |>
  inner_join(followups, by = "identifier", relationship = "many-to-many") |>
  filter(followup_sent > sent) |>
  slice_min(followup_sent, n = 1, with_ties = FALSE, by = id) |>
  select(id, followup_type, followup_sent)

weas <- weas |>
  left_join(ends, by = "id") |>
  mutate(
    end = if_else(
      !is.na(followup_sent) & followup_sent < expires,
      followup_sent,
      expires
    ),
    ended = case_when(
      end < expires & followup_type == "Cancel" ~ "cancelled",
      end < expires ~ "updated",
      TRUE ~ "expired"
    )
  )

# Areas ------------------------------------------------------------------------
# The polygon where the sender drew one, otherwise the counties named by SAME
# code. The polygon must overlap one of those counties, which catches a
# polygon written longitude first or a code for the wrong county.
sf_use_s2(FALSE)

counties <- st_read(file.path(map_data, "counties.geojson"), quiet = TRUE)

areas <- weas |>
  select(id, same) |>
  unnest(same) |>
  filter(str_detect(same, "^040\\d{3}$")) |>
  mutate(geoid = paste0("40", str_sub(same, 4, 6))) |>
  left_join(st_drop_geometry(counties), by = "geoid")

unresolved <- filter(areas, is.na(county))
if (nrow(unresolved) > 0) {
  print(unresolved)
  stop("SAME codes above match no Oklahoma county.")
}

area_lists <- areas |>
  distinct(id, county, name) |>
  arrange(id, name) |>
  summarise(
    county_ids = paste(county, collapse = ","),
    county_names = paste(name, collapse = ", "),
    .by = id
  )

# CAP polygons are "lat,lon lat,lon ...", closed.
parse_polygon <- function(text) {
  pairs <- str_split(str_squish(text), " ")[[1]]
  xy <- str_split_fixed(pairs, ",", 2)
  coords <- cbind(as.numeric(xy[, 2]), as.numeric(xy[, 1]))
  if (anyNA(coords) || nrow(coords) < 4) return(NULL)
  if (!all(coords[1, ] == coords[nrow(coords), ])) {
    coords <- rbind(coords, coords[1, ])
  }
  st_polygon(list(coords))
}

county_union <- function(ids) {
  counties |>
    filter(county %in% as.integer(str_split(ids, ",")[[1]])) |>
    st_union()
}

weas <- weas |>
  left_join(area_lists, by = "id") |>
  mutate(
    shapes = map(polygons, \(p) compact(map(p, parse_polygon))),
    has_polygon = map_int(shapes, length) > 0
  )

bad_polygons <- weas |>
  filter(map_int(polygons, length) != map_int(shapes, length))

if (nrow(bad_polygons) > 0) {
  print(select(bad_polygons, id, polygons))
  stop("WEAs above have a polygon that does not parse.")
}

weas <- weas |>
  mutate(
    geometry = map2(shapes, county_ids, \(s, ids) {
      if (length(s) > 0) st_union(st_make_valid(st_sfc(s)))[[1]]
      else county_union(ids)[[1]]
    }) |>
      st_sfc(crs = 4326)
  ) |>
  st_as_sf()

misplaced <- weas |>
  filter(has_polygon) |>
  mutate(overlaps = map2_lgl(geometry, county_ids, \(g, ids) {
    polygon <- st_sfc(g, crs = 4326)
    any(st_intersects(polygon, county_union(ids), sparse = FALSE))
  })) |>
  filter(!overlaps)

if (nrow(misplaced) > 0) {
  print(select(st_drop_geometry(misplaced), id, county_names))
  stop("WEAs above have a polygon outside every county they name.")
}

# Write ------------------------------------------------------------------------
weas <- weas |>
  mutate(
    local_start = as.Date(sent, tz = local_tz),
    local_end = as.Date(end, tz = local_tz)
  ) |>
  filter(local_end >= archive_start) |>
  arrange(sent)

message(
  "WEAs since ", archive_start, ": ", nrow(weas), ", ",
  sum(weas$has_polygon), " with a polygon, ",
  sum(weas$ended == "cancelled"), " cancelled early"
)

unlink(out, recursive = TRUE)
dir.create(out, recursive = TRUE)

weas |>
  transmute(
    id,
    t0 = as.integer(as.numeric(sent) %/% 60),
    t1 = as.integer(as.numeric(end) %/% 60),
    t_expires = as.integer(as.numeric(expires) %/% 60),
    d0 = as.integer(local_start - archive_start),
    d1 = as.integer(local_end - archive_start),
    event,
    sender_name,
    phone,
    long,
    ended,
    polygon = has_polygon,
    counties = county_ids,
    county_names
  ) |>
  st_write(
    file.path(out, "weas.geojson"),
    quiet = TRUE,
    layer_options = c("COORDINATE_PRECISION=4", "RFC7946=YES")
  )
