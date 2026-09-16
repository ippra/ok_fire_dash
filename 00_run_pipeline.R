# Run the Pipeline -------------------------------------------------------------
# Refresh from NOAA and IEM, rebuild the data, assemble the site. The entry
# point for a scheduled update. Each script still runs standalone, and each
# stops loudly on a problem, which stops the scripts after it: the last good
# site stays in place rather than being replaced by a quietly wrong one.

scripts <- c(
  "01_refresh_data.R",
  "02_refresh_warnings.R",
  "03_refresh_weas.R",
  "04_build_map_data.R",
  "05_build_warnings.R",
  "06_build_weas.R",
  "07_build_dashboard.R"
)

for (script in scripts) {
  message("\n== ", script, " ", format(Sys.time(), "%Y-%m-%d %H:%M:%S"))
  source(here::here(script), local = new.env())
}
