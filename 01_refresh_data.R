library(tidyverse)

source(here::here("00_paths.R"))

# Refresh the HMS Archive ------------------------------------------------------
# Incremental. Asks NOAA only for days not already on disk, plus the last
# lookback_days, which NOAA is still revising. A cold start is about 4,300 files
# and 20 minutes; a routine refresh is a handful of files and a few seconds.
#
# Downloads run one at a time. NOAA's server stalls when R's libcurl opens
# several transfers at once - every file timed out in testing - while
# sequential requests take about 0.2 seconds each.

dir.create(archive_dir, recursive = TRUE, showWarnings = FALSE)

today_utc <- as.Date(format(Sys.time(), tz = "UTC", "%Y-%m-%d"))
wanted <- seq(archive_start, today_utc, by = "day")

archive_path <- function(day) {
  file.path(
    archive_dir, format(day, "%Y"),
    paste0("hms_fire", format(day, "%Y%m%d"), ".csv")
  )
}

unavailable <- if (file.exists(unavailable_file)) {
  read_csv(unavailable_file, col_types = cols(day = col_date()))
} else {
  tibble(day = as.Date(character()))
}

on_disk <- file.exists(archive_path(wanted))
recent <- wanted > today_utc - lookback_days
fetch <- wanted[(!on_disk & !wanted %in% unavailable$day) | recent]

message(
  "Archive: ", sum(on_disk), " days on disk, ", length(fetch), " to fetch (",
  sum(!on_disk[wanted %in% fetch]), " new)"
)

# Download ---------------------------------------------------------------------
# Returns the HTTP status, or NA when every attempt failed to connect.
download_day <- function(url, dest, tries = 4) {
  for (attempt in seq_len(tries)) {
    handle <- curl::new_handle(connecttimeout = 30, timeout = 180)
    result <- tryCatch(
      curl::curl_fetch_disk(url, dest, handle = handle),
      error = function(e) NULL
    )
    if (!is.null(result) && result$status_code %in% c(200, 404)) {
      return(result$status_code)
    }
    Sys.sleep(2^attempt)
  }
  NA_integer_
}

hms_columns <- c(
  "Lon", "Lat", "YearDay", "Time", "Satellite", "Method", "Ecosystem", "FRP"
)

truncated <- if (file.exists(truncated_file)) {
  read_csv(truncated_file, col_types = cols(day = col_date()))
} else {
  tibble(day = as.Date(character()))
}

truncated_now <- as.Date(character())
clean_now <- as.Date(character())
failed_new <- as.Date(character())
failed_refetch <- as.Date(character())
newly_unavailable <- as.Date(character())

for (i in seq_along(fetch)) {
  day <- fetch[i]
  dest <- archive_path(day)
  tmp <- tempfile(fileext = ".txt")
  url <- paste0(hms_text_url, format(day, "%Y/%m/hms_fire%Y%m%d.txt"))

  status <- download_day(url, tmp)

  if (is.na(status)) {
    if (file.exists(dest)) {
      failed_refetch <- c(failed_refetch, day)
    } else {
      failed_new <- c(failed_new, day)
    }
    next
  }

  # A missing recent day is normal - today's file may not exist yet. A missing
  # older day is a gap in NOAA's archive and is recorded so it is asked once.
  if (status == 404) {
    if (day <= today_utc - lookback_days) {
      newly_unavailable <- c(newly_unavailable, day)
    }
    next
  }

  # A zero-byte file is a day NOAA published with no detections at all.
  raw <- if (file.size(tmp) == 0) {
    tibble(!!!set_names(rep(list(character()), 8), hms_columns))
  } else {
    read_csv(
      tmp,
      col_types = cols(.default = col_character()),
      progress = FALSE
    )
  }

  # A short read would be a quietly incomplete day, so the row count is checked
  # against the file itself.
  lines <- read_lines(tmp, progress = FALSE)
  expected <- max(sum(str_trim(lines) != "") - 1, 0)

  # NOAA occasionally publishes a file cut off mid-record - 2025-05-08 ends in
  # "NOAA 21, VI" - and readr drops that last line without reporting a
  # problem. Complete files end in a newline. The rows before the cut are
  # sound, so the day is kept, the partial line dropped, and the day recorded.
  last_byte <- as.raw(0x0a)
  if (file.size(tmp) > 0) {
    con <- file(tmp, "rb")
    seek(con, file.size(tmp) - 1)
    last_byte <- readBin(con, "raw", n = 1)
    close(con)
  }
  cut_off <- file.size(tmp) > 0 && last_byte != as.raw(0x0a)

  if (cut_off) {
    expected <- expected - 1
    raw <- slice_head(raw, n = expected)
    truncated_now <- c(truncated_now, day)
  } else {
    clean_now <- c(clean_now, day)
  }

  if (nrow(raw) != expected || !setequal(names(raw), hms_columns)) {
    message(url, ": ", nrow(raw), " rows read of ", expected)
    print(names(raw))
    stop("NOAA file above did not read cleanly - not writing a partial day.")
  }

  cropped <- raw |>
    mutate(across(everything(), str_trim)) |>
    select(all_of(hms_columns)) |>
    filter(
      as.numeric(Lon) >= crop_box[["xmin"]],
      as.numeric(Lon) <= crop_box[["xmax"]],
      as.numeric(Lat) >= crop_box[["ymin"]],
      as.numeric(Lat) <= crop_box[["ymax"]]
    )

  # Written beside the target and renamed, so an interrupted run never leaves a
  # truncated file that the next run would treat as complete.
  dir.create(dirname(dest), showWarnings = FALSE)
  write_csv(cropped, paste0(dest, ".part"), na = "")
  file.rename(paste0(dest, ".part"), dest)
  unlink(tmp)

  if (i %% 100 == 0) cat(format(day), i, "of", length(fetch), "\n")
}

if (length(newly_unavailable) > 0) {
  bind_rows(unavailable, tibble(day = newly_unavailable)) |>
    distinct() |>
    arrange(day) |>
    write_csv(unavailable_file)
}

# A day fetched clean this run is no longer truncated: the current day's file is
# still being written, and a later fetch completes it.
truncated_days <- c(truncated$day[!truncated$day %in% clean_now], truncated_now)
if (length(truncated_now) > 0 || any(truncated$day %in% clean_now)) {
  tibble(day = truncated_days) |>
    distinct() |>
    arrange(day) |>
    write_csv(truncated_file)
}

# What Came Down ---------------------------------------------------------------
message(
  "Refresh: ", length(clean_now) + length(truncated_now), " fetched, ",
  length(newly_unavailable), " newly unavailable, ",
  length(truncated_now), " cut off by NOAA, ",
  length(failed_refetch), " re-fetches failed (older copy kept)"
)

# A day never fetched is a gap the dashboard would draw as a day without fire.
# Stop so the build does not run; the next refresh asks for it again.
if (length(failed_new) > 0) {
  print(failed_new)
  stop("Days above could not be downloaded - the archive has gaps.")
}
