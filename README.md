# On Premise Azure DevOps MCP

This repo is forked from official microsoft ADO [MCP](https://github.com/microsoft/azure-devops-mcp)

## Spin up own ADO MCP server

Generate our own Base64 PAT:

```powershell
cd C:\azure-devops-mcp

$email = "suizer@gmail.com"
$token = "xxxxxxxxxxxxxxxx"

$env:PERSONAL_ACCESS_TOKEN = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${email}:${token}"))
```

Spin up a local instance of this MCP server to test authorisation:

```powershell
node dist/index.js TEST -a pat --server-url https://devops.suizer.com/TEST
```

Under cursor MCP settings, add:

```
"ado": {
    "type": "stdio",
    "command": "node",
    "args": [
        "C:\\Esri\\azure-devops-mcp\\dist\\index.js",
        "TEST",
        "-a",
        "pat",
        "--server-url",
        "https://devops.suizer.com/TEST"
    ],
    "env": {
        "PERSONAL_ACCESS_TOKEN": "",
        "LOG_LEVEL": "debug"
    }
}
```

The PAT value need to base64 converted, you may copy value from:

```powershell
$env:PERSONAL_ACCESS_TOKEN = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${email}:${token}"))
```

## Remote HTTP hosting (Copilot Studio / M365)

Copy `.env.sample` to `.env` and set NTLM credentials (or PAT). The server loads `.env` from the project root on startup.

```powershell
copy .env.sample .env
# edit .env — set ADO_MCP_USERNAME and ADO_MCP_PASSWORD

node dist/index.js PUB -a ntlm --server-url https://devops.esrisa.com/PUB `
  --transport http --host 127.0.0.1 --port 8000 --path /mcp
```

HTTP listens on port **8000** by default. HTTPS listens on port **8080** when `--tls-cert` and `--tls-key` are provided. Alternatively, terminate TLS in IIS/nginx and forward to `http://localhost:8000/mcp`.

### Cursor `mcp.json` (HTTP)

Start the server first (command above), then add to `~/.cursor/mcp.json`:

```json
"ado": {
  "type": "http",
  "url": "http://localhost:8000/mcp"
}
```

Use a port that is not already taken by another local MCP server. Credentials stay in `.env` on the server process — nothing sensitive is needed in `mcp.json`.

In Copilot Studio: Tools → Add tool → Model Context Protocol → enter the public HTTPS URL (e.g. `https://www.gerisa.com/ado/mcp` or your reverse-proxy URL).

Options:

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
