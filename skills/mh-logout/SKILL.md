---
name: mh-logout
description: Sign out of Memory House on this device and clear its shared credentials.
disable-model-invocation: true
---

Call the plugin's `memory_logout` MCP tool with no arguments. This revokes the
current refresh token and clears the local sign-in shared by the user's
installed Memory House apps on this device.

Report the tool's outcome. If remote revocation fails, do not claim complete
revocation even if local credentials were cleared. Previously issued access
tokens may remain valid until expiry. Never display credentials or enrollment
codes, and do not open a browser or sign the user back in.
