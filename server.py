from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import os
import socket
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))


def lan_ip():
    """The address this machine is reachable at from a phone on the same Wi-Fi.

    Resolved by opening a UDP socket toward a public address and reading back
    the interface the OS picked. Nothing is sent, and no DNS is needed — it just
    forces a routing decision. Hostname lookup is not a substitute: on macOS it
    usually answers 127.0.0.1.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # A phone will otherwise serve a cached build for hours. Twice in this
        # project a "the change isn't working" report was a stale cache.
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    # 0.0.0.0, not 127.0.0.1 — a loopback bind is invisible to the phone.
    httpd = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    ip = lan_ip()
    print(f'Serving {ROOT}')
    print(f'  this machine   http://127.0.0.1:{port}/')
    if ip:
        print(f'  phone / LAN    http://{ip}:{port}/')
    else:
        print('  phone / LAN    unavailable — no network interface found')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down server')
        httpd.server_close()
