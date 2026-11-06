"""Post rendered strips to the draw board, one titled frame per strip.

    python3 scripts/comics/board.py [STRIP_DIR] [--board sporefall-animation-scenarios]

Images go up over the board's HTTP MCP endpoint (Streamable HTTP), read from
disk and base64-encoded here, so nothing large is pasted through a tool call.
Ids are stable (`strip-A`, `frame-A`, ...), so re-running replaces in place.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import urllib.request
from pathlib import Path

from PIL import Image

URL = "https://draw.hypnodroid.com/mcp"

TITLES = {
    "A": "A. Quickdraw at Bog Lock 3",
    "B": "B. Hard hit, long goodbye (death tumble)",
    "C": "C. Wall slam (ragdoll-lite)",
    "D": "D. Two phones, one fight (display physics stays local)",
    "E": "E. Spore-drone down",
    "F": "F. Good boy, interrupted (fidget -> alert)",
    "G": "G. Room clear (holster, turn, skid)",
    "H": "H. The rotoscope route (fluid draw)",
}


class Mcp:
    def __init__(self, handle: str) -> None:
        self.session: str | None = None
        self.next_id = 1
        self.handle = handle

    def call(self, method: str, params: dict | None = None, notify: bool = False) -> dict | None:
        body: dict = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            body["params"] = params
        if not notify:
            body["id"] = self.next_id
            self.next_id += 1
        headers = {"content-type": "application/json", "accept": "application/json, text/event-stream",
                   "x-handle": self.handle, "user-agent": "sporefall-comics/1"}
        if self.session:
            headers["mcp-session-id"] = self.session
        req = urllib.request.Request(URL, json.dumps(body).encode(), headers)
        with urllib.request.urlopen(req, timeout=180) as resp:
            self.session = self.session or resp.headers.get("mcp-session-id")
            raw = resp.read().decode()
        if notify:
            return None
        for line in raw.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:])
        return json.loads(raw) if raw.strip() else None

    def tool(self, name: str, args: dict) -> str:
        res = self.call("tools/call", {"name": name, "arguments": args})
        if res is None or "error" in res:
            raise RuntimeError(f"{name}: {res}")
        result = res["result"]
        text = " ".join(c.get("text", "") for c in result.get("content", []))
        if result.get("isError"):
            raise RuntimeError(f"{name}: {text}")
        return text


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", nargs="?", default="/mnt/d/tmp/cast-walks/comics")
    ap.add_argument("--board", default="sporefall-animation-scenarios")
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    mcp = Mcp("comics-1106")
    mcp.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                            "clientInfo": {"name": "sporefall-comics", "version": "1"}})
    mcp.call("notifications/initialized", notify=True)
    print(mcp.tool("open", {"boardName": a.board, "agent": "comics-1106", "title": "Sporefall: animation scenarios"}))

    col_w, row_h, pad = 2000, 1220, 40
    for n, key in enumerate(TITLES):
        if a.only and key not in a.only.split(","):
            continue
        png = Path(a.dir) / f"strip-{key}.png"
        im = Image.open(png).convert("RGB")
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=92)
        x, y = (n % 2) * col_w, (n // 2) * row_h
        w = 1800 if im.width > 1500 else 1206
        h = round(im.height * w / im.width)
        print(mcp.tool("draw", {"ops": [{"kind": "put", "drafts": [
            {"id": f"frame-{key}", "type": "frame", "x": x - pad, "y": y - pad, "width": w + 2 * pad,
             "height": h + 2 * pad, "name": TITLES[key]}]}]}))
        print(mcp.tool("image", {"id": f"strip-{key}", "data": base64.b64encode(buf.getvalue()).decode(),
                                 "x": x, "y": y, "width": w}))


if __name__ == "__main__":
    main()
