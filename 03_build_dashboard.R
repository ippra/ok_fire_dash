library(tidyverse)
library(jsonlite)

source(here::here("00_paths.R"))

# Dashboard Assembly -----------------------------------------------------------
# Copies the hand-edited front end in site/ and 02's map data into one static
# directory. Computes nothing: every detection and count is 02's.
#
# Writes outputs/03_site/ - plain static files, no server code. Preview:
#   python3 preview.py

data_in <- file.path(outputs, "02_map_data")
out <- file.path(outputs, "03_site")

manifest_path <- file.path(data_in, "manifest.json")
if (!file.exists(manifest_path)) {
  stop("No map data - run 02_build_map_data.R first.")
}

manifest <- read_json(manifest_path)
build <- manifest$build

# Every chunk the manifest lists must be on disk, or a date range reaching it
# would fail in the browser rather than here.
chunk_files <- map_chr(manifest$chunks, "file")
missing_chunks <- chunk_files[!file.exists(file.path(data_in, chunk_files))]

if (length(missing_chunks) > 0) {
  print(missing_chunks)
  stop("Chunks above are in the manifest but not in ", data_in, ".")
}

# Assemble ---------------------------------------------------------------------
# Built beside the live directory and swapped in at the end, so a host serving
# outputs/03_site during a scheduled refresh never sees a half-copied site.
staging <- paste0(out, ".next")
unlink(staging, recursive = TRUE)
dir.create(staging, recursive = TRUE)

invisible(file.copy(
  list.files(site_src, full.names = TRUE),
  staging,
  recursive = TRUE
))

dir.create(file.path(staging, "data"))
invisible(file.copy(
  list.files(data_in, full.names = TRUE),
  file.path(staging, "data")
))

# Every stamped asset URL changes with the data build, so a host may cache
# engine.js and engine.css indefinitely. index.html cannot stamp itself and
# must be served with Cache-Control: no-cache; manifest.json is fetched with a
# query string and no-store.
for (file in c("index.html", "engine.js", "engine.css")) {
  path <- file.path(staging, file)
  read_file(path) |>
    str_replace_all(fixed("__BUILD__"), build) |>
    write_file(path)
}

# Guards -----------------------------------------------------------------------
published <- list.files(staging, recursive = TRUE, all.files = TRUE)

leaked <- published[str_detect(published, "\\.(R|csv|part|DS_Store)$")]
if (length(leaked) > 0) {
  print(leaked)
  stop("Files above do not belong in the published site.")
}

unstamped <- c("index.html", "engine.js", "engine.css") |>
  keep(\(f) str_detect(read_file(file.path(staging, f)), fixed("__BUILD__")))
if (length(unstamped) > 0) {
  print(unstamped)
  stop("Files above still carry the __BUILD__ placeholder.")
}

unlink(out, recursive = TRUE)
invisible(file.rename(staging, out))

site_mb <- sum(file.size(file.path(out, published))) / 1e6
message(
  "Site: ", length(published), " files, ", round(site_mb, 1), " MB, build ",
  build
)
