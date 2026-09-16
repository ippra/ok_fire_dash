library(tidyverse)
library(jsonlite)

source(here::here("00_paths.R"))

# Refresh Wireless Emergency Alerts --------------------------------------------
# Tops up data/ipaws/ from FEMA's IPAWS archive: every message not sent by the
# National Weather Service since the newest one on disk, less the lookback,
# keeping those that name an Oklahoma county. 06_build_weas.R decides which of
# them are wildfire WEAs; this script keeps every Oklahoma message, alerts,
# updates and cancellations alike, because a cancellation is what ends an alert.

messages_dir <- file.path(weas_dir, "messages")
dir.create(messages_dir, recursive = TRUE, showWarnings = FALSE)

index <- if (file.exists(weas_index)) {
  read_csv(
    weas_index,
    col_types = cols(.default = col_character(), sent = col_datetime())
  )
} else {
  tibble(
    id = character(), sent = as.POSIXct(character(), tz = "UTC"),
    sender = character(), status = character(), msg_type = character()
  )
}

since <- if (nrow(index) == 0) {
  as.POSIXct(paste(archive_start, "00:00:00"), tz = "UTC")
} else {
  max(index$sent) - days(ipaws_lookback_days)
}

# The window stops 26 hours back. FEMA publishes each message as it turns 24
# hours old, so anything newer could arrive between one page and the next and
# shift the paging; the lookback picks it up on a later run.
until <- Sys.time() - hours(26)

stamp <- \(x) format(x, "%Y-%m-%dT%H:%M:%S.000Z", tz = "UTC")

query_filter <- paste0(
  "sender ne '", nws_sender, "' and sent ge '", stamp(since),
  "' and sent lt '", stamp(until), "'"
)

# Pages ------------------------------------------------------------------------
# Messages run about 22 KB each, most of it the signature block, so pages are
# kept small enough to parse without holding a gigabyte at once. Sorting on id
# as well as time keeps the paging stable where messages share a timestamp.
page_size <- 2000

fetch_json <- function(params, tries = 4) {
  url <- paste0(
    ipaws_url, "?",
    paste(
      names(params),
      map_chr(params, \(v) curl::curl_escape(v)),
      sep = "=", collapse = "&"
    )
  )
  for (attempt in seq_len(tries)) {
    handle <- curl::new_handle(connecttimeout = 30, timeout = 600)
    result <- tryCatch(curl::curl_fetch_memory(url, handle), error = \(e) NULL)
    if (!is.null(result) && result$status_code == 200) {
      return(fromJSON(rawToChar(result$content)))
    }
    Sys.sleep(5 * attempt)
  }
  stop("OpenFEMA did not answer: ", url)
}

expected <- fetch_json(list(
  `$filter` = query_filter, `$top` = "1", `$select` = "id",
  `$inlinecount` = "allpages"
))$metadata$count

message(
  "IPAWS: ", expected, " non-NWS messages since ",
  format(since, "%Y-%m-%d %H:%M", tz = "UTC"), " UTC"
)

# An Oklahoma county's SAME code is 0, then state FIPS 40, then the county.
oklahoma_same <- "<valueName>SAME</valueName>\\s*<value>040\\d{3}</value>"

seen <- character()
kept <- list()

for (skip in seq(0, max(expected - 1, 0), by = page_size)) {
  page <- fetch_json(list(
    `$filter` = query_filter,
    `$orderby` = "sent asc,id asc",
    `$select` = "id,sent,sender,status,msgType,originalMessage",
    `$top` = as.character(page_size),
    `$skip` = as.character(skip)
  ))$IpawsArchivedAlerts

  if (length(page) == 0 || nrow(page) == 0) break
  seen <- c(seen, page$id)

  oklahoma <- page |>
    filter(str_detect(originalMessage, oklahoma_same))

  for (i in seq_len(nrow(oklahoma))) {
    write_file(
      oklahoma$originalMessage[i],
      file.path(messages_dir, paste0(oklahoma$id[i], ".xml"))
    )
  }

  kept[[length(kept) + 1]] <- oklahoma |>
    transmute(
      id,
      sent = ymd_hms(sent, tz = "UTC"),
      sender,
      status,
      msg_type = msgType
    )

  cat(skip + nrow(page), "of", expected, "\n")
}

# A page that shifted under the paging would drop or repeat messages without
# any request failing, so the ids read must be exactly the count promised.
if (n_distinct(seen) != expected || length(seen) != expected) {
  stop(
    "Read ", length(seen), " messages (", n_distinct(seen), " distinct) of ",
    expected, " - the archive changed during paging. Run again."
  )
}

index <- bind_rows(index, kept) |>
  distinct(id, .keep_all = TRUE) |>
  arrange(sent, id)

message_files <- file.path(messages_dir, paste0(index$id, ".xml"))
missing_files <- index$id[!file.exists(message_files)]
if (length(missing_files) > 0) {
  print(missing_files)
  stop("Index rows above have no message file.")
}

write_csv(index, weas_index)

message(
  "IPAWS: ", sum(map_int(kept, nrow)), " Oklahoma messages in this window, ",
  nrow(index), " on disk"
)
