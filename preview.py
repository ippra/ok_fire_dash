"""Serve the built site for preview, without letting the browser cache the HTML.

Usage:
    python3 preview.py [port]          # defaults to 8902

Every asset the site loads carries a ?v=<build> stamp, so a rebuild changes
their URLs and the browser fetches them fresh. index.html is the one file that
cannot stamp itself, and `python3 -m http.server` sends no cache headers at
all — so the browser keeps its copy, keeps asking for the previous build's
engine.js, and a rebuild appears to have done nothing. The symptom is a page
that looks stale in a way no amount of rebuilding fixes.

A real host needs less than this: index.html with Cache-Control: no-cache, and
everything else cached as long as it likes, because every other asset carries a
?v=<build> stamp. A preview server can be blunter — see the deploy section of
README.md for what an actual host has to do.
"""

import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "outputs", "05_site")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Everything, not just the HTML. A real host only needs no-cache on
        # index.html, because every other asset carries a ?v=<build> stamp that
        # changes when it does. Here the point is different: you have just
        # rebuilt and you want to see it, so nothing is served from the
        # browser's copy. no-cache means "cache it, but revalidate first", so
        # the server still answers 304 when nothing changed.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass   # a request log per asset drowns the build output


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8902
    if not os.path.exists(os.path.join(ROOT, "index.html")):
        sys.exit("No built site at %s - run 05_build_dashboard.R first." % ROOT)
    handler = functools.partial(Handler, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", port), handler) as httpd:
        print("Serving %s\n  http://localhost:%d" % (ROOT, port))
        httpd.serve_forever()


if __name__ == "__main__":
    main()
