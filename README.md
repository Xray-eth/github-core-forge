# GitHub Core Forge

A standalone, deterministic GitHub-compatible forge built for the github-core-clone-01 checks. It runs on Node.js 22 and uses only built-in modules.

Run it with `npm start`. The server binds an ephemeral port and registers with the trial environment through `MAKEFUN_ENV_URL`.

The forge surfaces are REST v3, Git smart HTTP, GraphQL v4, and MCP over Streamable HTTP. No secrets are stored in this repository.
