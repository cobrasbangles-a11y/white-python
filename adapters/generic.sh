#!/bin/sh
# Drop-in wrapper for an agent CLI with no hook system.
#
# Copy this next to your agent, point AGENT at it, and run this instead.
# Everything white-python needs is the two calls at the bottom — or the single
# `white-python wrap` line, if you'd rather not manage them yourself.

set -eu

WPY="${WPY:-white-python}"
AGENT="${AGENT:-aider}"

# --- Option A: let the wrapper do it (recommended) -------------------------
# Watches the agent's output; 8 seconds of silence means it's waiting for you.
exec "$WPY" wrap --idle 8 -- "$AGENT" "$@"

# --- Option B: drive it by hand -------------------------------------------
# Useful when you know exactly when the agent starts and stops. The trap makes
# sure the feeds close even if the agent crashes or you hit Ctrl-C.
#
# "$WPY" start --session "$AGENT-$$"
# trap '"$WPY" stop --session "$AGENT-$$"' EXIT INT TERM
# "$AGENT" "$@"
