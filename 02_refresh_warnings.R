library(tidyverse)

source(here::here("00_paths.R"))

# Refresh Fire Warnings --------------------------------------------------------
# Pulls every NWS Fire Warning (FRW) from IEM since the day before the archive
# starts, for every office. 04_build_warnings.R keeps the Oklahoma ones. The
# pull replaces data/frw_text/ whole rather than topping it up; see 00_paths.R.
#
# fire_warning_archive holds the same products, but its archive is private and
# refreshed by hand, and this pipeline runs unattended on GitHub, so it fetches
# its own copy.

# The PIL is a prefix match, so FRW returns every office. limit caps the
# number of products; a pull that reaches it would be silently incomplete.
limit <- 9999

query <- paste0(
  frw_url,
  "?pil=FRW&fmt=zip&order=asc&limit=", limit,
  "&sdate=", format(archive_start - 1, "%Y-%m-%dT00:00Z"),
  "&edate=", format(Sys.Date() + 2, "%Y-%m-%dT00:00Z")
)

zip_path <- tempfile(fileext = ".zip")
result <- curl::curl_fetch_disk(
  query,
  zip_path,
  handle = curl::new_handle(connecttimeout = 30, timeout = 180)
)

if (result$status_code != 200) {
  stop("IEM returned HTTP ", result$status_code, " for ", query)
}

listing <- unzip(zip_path, list = TRUE)

message("Warnings: ", nrow(listing), " FRW products from IEM")

if (nrow(listing) == 0) {
  stop("IEM returned no Fire Warnings - not replacing the archive.")
}

if (nrow(listing) >= limit) {
  stop("IEM returned ", limit, " products, its limit - the pull is truncated.")
}

# A corrected product (-RRA) carries the original's name and follows it in the
# zip, so extracting in order leaves the correction on disk.
duplicates <- sum(duplicated(listing$Name))
message("Corrections: ", duplicates, " products superseded by a later copy")

staging <- paste0(warnings_dir, ".next")
unlink(staging, recursive = TRUE)
dir.create(staging, recursive = TRUE)
unzip(zip_path, exdir = staging, overwrite = TRUE)

extracted <- list.files(staging, pattern = "\\.txt$")
if (length(extracted) != n_distinct(listing$Name)) {
  stop("Extracted ", length(extracted), " files from ",
       n_distinct(listing$Name), " distinct products.")
}

unlink(warnings_dir, recursive = TRUE)
invisible(file.rename(staging, warnings_dir))
