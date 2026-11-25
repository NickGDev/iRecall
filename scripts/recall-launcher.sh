#!/bin/bash
# Fallback launcher (used if swiftc unavailable) — starts server, opens dashboard.
LABEL="dev.recall.server"
UID_N="$(id -u)"
launchctl kickstart -k "gui/$UID_N/$LABEL" 2>/dev/null || launchctl load -w "$HOME/Library/LaunchAgents/dev.recall.server.plist" 2>/dev/null
sleep 1
open "http://127.0.0.1:8787/"
