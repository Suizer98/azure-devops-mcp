# Custom / on-prem Azure DevOps MCP

This fork adds on-prem Azure DevOps Server support (NTLM, HTTP hosting, collections) on top of the official Microsoft [Azure DevOps MCP](https://github.com/microsoft/azure-devops-mcp).

Microsoft docs stay in `README.md`. Deploy and develop from the `custom-onprem` branch, not `main`.

## Branch layout

| Branch          | Purpose                                                   |
| --------------- | --------------------------------------------------------- |
| `main`          | Clean mirror of Microsoft upstream                        |
| `custom-onprem` | All custom/on-prem work (NTLM, HTTP, Docker, collections) |

Remotes:

```powershell
git remote add upstream https://github.com/microsoft/azure-devops-mcp.git
# origin = your fork
```

## Pull Microsoft updates (easy sync)

`custom-onprem` should stay a thin layer on top of `main` (a few thematic commits ahead, 0 behind).

```powershell
git fetch upstream
git checkout main
git reset --hard upstream/main
git push origin main

git checkout custom-onprem
git rebase main
# fix only remaining thin-hook conflicts in index/tools if any
git push --force-with-lease origin custom-onprem
```

Do not merge Microsoft into a customized `main`. Never merge `main` into `custom-onprem` with a merge commit — always rebase.

## Code isolation

Custom logic lives under `src/custom/`:

- `organization.ts` — on-prem collection/URL resolution
- `cli.ts` — HTTP/server CLI flags
- `auth.ts` — NTLM authenticator
- `runtime.ts` — HTTP transport + WebApi client wiring
- `tools.ts` — on-prem collection tools registration

Microsoft files should only have thin hooks (imports + one call site). Prefer new files under `src/custom/` over editing upstream modules.

## Spin up locally (PAT)

```powershell
$email = "you@example.com"
$token = "YOUR_ADO_PAT"
$env:PERSONAL_ACCESS_TOKEN = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${email}:${token}"))

node dist/index.js YOUR_COLLECTION -a pat --server-url https://devops.example.com/YOUR_COLLECTION
```

Cursor `mcp.json` (stdio):

```json
"ado": {
  "type": "stdio",
  "command": "node",
  "args": [
    "C:\\path\\to\\azure-devops-mcp\\dist\\index.js",
    "YOUR_COLLECTION",
    "-a",
    "pat",
    "--server-url",
    "https://devops.example.com/YOUR_COLLECTION"
  ],
  "env": {
    "PERSONAL_ACCESS_TOKEN": "BASE64_OF_email:token",
    "LOG_LEVEL": "debug"
  }
}
```

## Remote HTTP hosting (NTLM)

Each client sends NTLM credentials via headers. No server-side password `.env` needed for HTTP mode.

```powershell
node dist/index.js _ -a ntlm --server-url https://devops.example.com `
  --transport http --host 0.0.0.0 --port 8000 --path /mcp
```

Cursor `mcp.json` (HTTP):

```json
"ado": {
  "type": "http",
  "url": "http://localhost:8000/mcp",
  "headers": {
    "X-ADO-MCP-Username": "DOMAIN\\your.user",
    "X-ADO-MCP-Password": "your-domain-password",
    "X-ADO-MCP-Collection": "YOUR_COLLECTION"
  }
}
```

Collection can also be chosen later with `core_list_collections` / `core_set_collection`.

## Cursor skill (ado-inhouse)

The repo ships a Cursor agent skill at `.cursor/skills/ado-inhouse-mcp/SKILL.md`. It teaches agents how to call the MCP (set collection, list, then read files). Company-specific notes start empty; agents append them after real queries.

Cursor only auto-loads personal skills from `%USERPROFILE%\.cursor\skills\` (every project) or project skills from that repo's `.cursor/skills\`. To use it in any workspace, copy the folder once:

```powershell
$dest = Join-Path $env:USERPROFILE ".cursor\skills\ado-inhouse-mcp"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item ".\.cursor\skills\ado-inhouse-mcp\SKILL.md" $dest -Force
```

Recommend to start a new Cursor chat after copying. If you keep a personal copy, that is the file agents should update; re-copy from git only when you want a fresh protocol template.

### Docker Compose

Run the MCP HTTP server in a container:

```powershell
Copy-Item .env.sample .env
# edit .env: set AZURE_DEVOPS_SERVER_URL (and optionally ADO_MCP_PORT)

docker compose up --build -d
curl http://localhost:8000/health
```

Point Cursor `mcp.json` at the host (use the VM IP if remote):

```json
"ado-inhouse": {
  "type": "http",
  "url": "http://HOST_OR_IP:8000/mcp",
  "headers": {
    "X-ADO-MCP-Username": "DOMAIN\\your.user",
    "X-ADO-MCP-Password": "your-domain-password",
    "X-ADO-MCP-Collection": "YOUR_COLLECTION"
  }
}
```

Useful commands:

```powershell
docker compose logs -f ado-mcp
docker compose down
```

NTLM credentials stay in the client headers — do not put passwords in the compose `.env` for HTTP mode. See `docker-compose.yml` and `.env.sample`.

### Ngrok (quick HTTPS tunnel)

Terminal 1: start HTTP mode with `--host 0.0.0.0`.

Terminal 2: `ngrok http 8000`

Point `mcp.json` `url` at the ngrok HTTPS URL + `/mcp`.

| Flag                       | Default     | Purpose                                     |
| -------------------------- | ----------- | ------------------------------------------- |
| `--transport http`         | `stdio`     | Enable remote HTTP mode                     |
| `--port`                   | `8000`      | HTTP listen port                            |
| `--https-port`             | `8080`      | HTTPS listen port (with TLS cert/key)       |
| `--tls-cert` / `--tls-key` | —           | Enable HTTPS listener                       |
| `--host`                   | `127.0.0.1` | Bind address (`0.0.0.0` for remote)         |
| `--path`                   | `/mcp`      | MCP endpoint path                           |
| `--allowed-hosts`          | —           | Host header allowlist (use with `0.0.0.0`)  |
| `--http-stateless`         | off         | Stateless POST-only mode for load balancers |

Health check: `GET /health` returns `{"status":"ok"}`.

## Security notes

- Never commit PATs, passwords, or tokens into git remotes or docs.
- If a GitHub PAT was ever embedded in a remote URL, rotate it on GitHub and set origin to a clean HTTPS/SSH URL.
