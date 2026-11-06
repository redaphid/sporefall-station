"""Build the dashboard montage and place it on the draw board over the MCP HTTP API.

Usage: python3 push_dash.py
Places the newest montage as `dash-latest` and appends a timestamped copy to a
history column, so the board keeps a picture of every tick across crashes.
"""
import base64
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

URL = "https://draw.hypnodroid.com/mcp"
BOARD = "sporefall-overnight-1106"
HERE = Path(__file__).resolve().parent
HISTORY_X, HISTORY_W, HISTORY_H = 2700, 420, 300


class Mcp:
    def __init__(self) -> None:
        self.session = None
        self.next_id = 1

    def call(self, method: str, params: dict | None = None, notify: bool = False) -> dict | None:
        body = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            body["params"] = params
        if not notify:
            body["id"] = self.next_id
            self.next_id += 1
        headers = {"content-type": "application/json",
                   "accept": "application/json, text/event-stream",
                   "x-handle": "sporefall-coordinator", "user-agent": "sporefall-dash/1"}
        if self.session:
            headers["mcp-session-id"] = self.session
        req = urllib.request.Request(URL, json.dumps(body).encode(), headers)
        with urllib.request.urlopen(req, timeout=120) as resp:
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
        if "error" in res:
            raise RuntimeError(f"{name}: {res['error']}")
        result = res["result"]
        text = " ".join(c.get("text", "") for c in result.get("content", []))
        if result.get("isError"):
            raise RuntimeError(f"{name}: {text}")
        return text


def main() -> None:
    stamp = time.strftime("%H%M")
    png = HERE / f"dash-{stamp}.png"
    subprocess.run([sys.executable, str(HERE / "montage.py"), str(png)], check=True)
    data = base64.b64encode(png.with_suffix(".jpg").read_bytes()).decode()

    mcp = Mcp()
    mcp.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                            "clientInfo": {"name": "sporefall-dash", "version": "1"}})
    mcp.call("notifications/initialized", notify=True)
    mcp.tool("open", {"boardName": BOARD, "agent": "dashboard"})
    print(mcp.tool("image", {"id": "dash-latest", "data": data, "x": 1500, "y": 140, "width": 1100}))

    tail = Path("/mnt/d/tmp/cast-walks/PROGRESS.md").read_bytes().replace(b"\0", b"").decode(errors="replace")
    lines = [ln[:150] for ln in tail.strip().splitlines()[-10:]]
    print(mcp.tool("draw", {"ops": [{"kind": "put", "drafts": [{
        "id": "progress-tail", "type": "text", "x": 0, "y": 1120, "fontSize": 16,
        "text": f"PROGRESS.md tail at {time.strftime('%H:%M')}\n" + "\n".join(lines)}]}]}))

    history = sorted(HERE.glob("dash-*.jpg"))
    slot = len(history) - 1
    print(mcp.tool("image", {"id": f"dash-{time.strftime('%m%d')}-{stamp}", "data": data,
                             "x": HISTORY_X, "y": 140 + slot * (HISTORY_H + 40), "width": HISTORY_W}))
    print(mcp.tool("draw", {"ops": [{"kind": "put", "drafts": [{
        "id": f"dash-label-{time.strftime('%m%d')}-{stamp}", "type": "text", "x": HISTORY_X,
        "y": 140 + slot * (HISTORY_H + 40) - 24, "text": f"tick {time.strftime('%H:%M')}",
        "fontSize": 16}]}]}))


if __name__ == "__main__":
    main()
