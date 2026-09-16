# Run the Pipeline -------------------------------------------------------------
# Refresh from NOAA, rebuild the map data, assemble the site. The entry point
# for a scheduled update. Each script still runs standalone, and each stops
# loudly on a problem, which stops the scripts after it: the last good site
# stays in place rather than being replaced by a quietly wrong one.

scripts <- c(
  "01_refresh_data.R",
  "02_build_map_data.R",
  "03_build_dashboard.R"
)

for (script in scripts) {
  message("\n== ", script, " ", format(Sys.time(), "%Y-%m-%d %H:%M:%S"))
  source(here::here(script), local = new.env())
}
