"""
Serves the Vercel Python functions under api/checks locally, the same way the
platform invokes them: one path per file, each handled by that file's `handler`.

This exists so the Python pack is exercised rather than asserted. The tests start
this server and drive the real functions over a real socket, so what passes the
gate is the code that deploys, not a TypeScript imitation of it.

    python3 scripts/serve_python_checks.py [port]
"""

import importlib.util
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FUNCTIONS_DIR = os.path.join(ROOT, "api", "checks")


def load_functions():
    routes = {}
    for name in sorted(os.listdir(FUNCTIONS_DIR)):
        if not name.endswith(".py") or name.startswith("_"):
            continue
        path = os.path.join(FUNCTIONS_DIR, name)
        spec = importlib.util.spec_from_file_location(f"api_checks_{name[:-3]}", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        routes[f"/api/checks/{name[:-3]}"] = module.handler
    return routes


ROUTES = load_functions()


class Router(BaseHTTPRequestHandler):
    def _dispatch(self, method):
        target = ROUTES.get(self.path.split("?")[0])
        if target is None:
            body = b'{"error":"no such function"}'
            self.send_response(404)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # The function's own handler does the work, bound to this connection, so
        # the request it sees is the one Vercel would hand it.
        target.__dict__[method](self)

    def do_GET(self):
        self._dispatch("do_GET")

    def do_POST(self):
        self._dispatch("do_POST")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    server = HTTPServer(("127.0.0.1", port), Router)
    # Printed so a caller that asked for port 0 learns which port it got.
    print(f"python checks on http://127.0.0.1:{server.server_port}", flush=True)
    server.serve_forever()
