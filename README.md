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
        "C:\\azure-devops-mcp\\dist\\index.js",
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

## Remote HTTP hosting

Each user sends their own NTLM credentials via HTTP headers. No server-side `.env` needed for HTTP mode.

```powershell
node dist/index.js TEST -a ntlm --server-url https://devops.suizer.com/TEST `
  --transport http --host 127.0.0.1 --port 8000 --path /mcp
```

`~/.cursor/mcp.json`:

```json
"ado": {
  "type": "http",
  "url": "http://localhost:8000/mcp",
  "headers": {
    "X-ADO-MCP-Username": "DOMAIN\\your.user",
    "X-ADO-MCP-Password": "your-domain-password"
  }
}
```

Use plain strings in `headers`. Keep `mcp.json` private. Use HTTPS when the server is not on localhost.

### No collection required at startup

You do not need to specify a collection when starting the server. Pass `_` as the organization argument and point `--server-url` at the server root (not a collection URL such as `/TEST`).

```powershell
node dist/index.js _ -a ntlm --server-url https://devops.esrisa.com `
  --transport http --host 0.0.0.0 --port 8000 --path /mcp
```

The collection is chosen later, per client session. Optionally set `X-ADO-MCP-Collection` in `mcp.json`, or call `core_list_collections` (with a filter) or `core_set_collection` in the MCP session. Change the header value to switch collections (for example `DEPT1`, `DEPT2`).

```json
"ado": {
  "type": "http",
  "url": "http://localhost:8000/mcp",
  "headers": {
    "X-ADO-MCP-Username": "DOMAIN\\your.user",
    "X-ADO-MCP-Password": "your-domain-password",
    "X-ADO-MCP-Collection": "TEST"
  }
}
```

For Copilot Studio or IIS, point to the public hosted HTTPS URL.

### Test with free tier Ngrok

Terminal 1:

```powershell
node dist/index.js TEST -a ntlm --server-url https://devops.suizer.com/TEST `
  --transport http --host 0.0.0.0 --port 8000 --path /mcp
```

Terminal 2: `ngrok http 8000`

Set `"url"` in `mcp.json` to the ngrok HTTPS URL + `/mcp`. Use `--host 0.0.0.0` so any ngrok hostname works (free URLs change each restart). If your ngrok URL changed — restart with `0.0.0.0` or update `--allowed-hosts`.

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
