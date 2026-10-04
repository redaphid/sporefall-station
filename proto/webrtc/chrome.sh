#!/bin/bash
exec "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" --remote-debugging-port=9273 \
  '--user-data-dir=C:\Users\hypnodroid\AppData\Local\Temp\sporefall-webrtc-bench-94f0' \
  --no-first-run --no-default-browser-check \
  --disable-features=WebRtcHideLocalIpsWithMdns \
  --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
  http://localhost:8853/
