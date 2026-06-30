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
