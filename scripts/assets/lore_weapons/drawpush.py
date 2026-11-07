"""Place PNGs on the sporefall-weapons draw board over the MCP HTTP API.
Usage: python3 drawpush.py ID X Y WIDTH file.png [ID X Y WIDTH file.png ...]"""
import base64, sys, importlib.util
spec = importlib.util.spec_from_file_location("pd", "/mnt/d/tmp/cast-walks/dashboard/push_dash.py")
pd = importlib.util.module_from_spec(spec); spec.loader.exec_module(pd)
BOARD = "sporefall-weapons"
def main(args):
    mcp = pd.Mcp()
    mcp.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "weapons-worker", "version": "1"}})
    mcp.call("notifications/initialized", notify=True)
    print(mcp.tool("open", {"boardName": BOARD, "agent": "weapons-worker"}))
    for i in range(0, len(args), 5):
        id_, x, y, w, f = args[i:i+5]
        data = base64.b64encode(open(f, "rb").read()).decode()
        print(mcp.tool("image", {"id": id_, "data": data, "x": float(x), "y": float(y), "width": float(w)}))
if __name__ == "__main__":
    main(sys.argv[1:])
