#Requires -RunAsAdministrator
# Generic IIS reverse proxy for the Azure DevOps MCP HTTP server.
# Default: HTTP on LAN :7000, proxy to Docker on 127.0.0.1:7001. No certificate required.
# Does not change IIS sites on other ports.
#
# Usage:
#   Set ADO_MCP_PORT=7001 in .env, then docker compose up -d
#   .\scripts\iis-mcp-reverse-proxy.generic.ps1
#   .\scripts\iis-mcp-reverse-proxy.generic.ps1 -ListenPort 7000 -BackendPort 7001
#   .\scripts\iis-mcp-reverse-proxy.generic.ps1 -UseHttps -HostName mcp.example.com -Thumbprint ABCDEF...

param(
    [int]$ListenPort = 7000,
    [int]$BackendPort = 7001,
    [string]$SiteName = "ado-mcp",
    [string]$PhysicalPath = "C:\inetpub\ado-mcp",
    [string]$HostName = "",
    [string]$IssuerFilter = "",
    [switch]$UseHttps,
    [string]$Thumbprint = "",
    [switch]$SkipModuleInstall
)

$ErrorActionPreference = "Stop"

function Get-DefaultHostName {
    $computer = Get-CimInstance Win32_ComputerSystem
    if ($computer.PartOfDomain -and $computer.Domain) {
        return "$($computer.DNSHostName).$($computer.Domain)".ToLower()
    }
    return $computer.DNSHostName.ToLower()
}

if ($UseHttps -and -not $HostName) {
    $HostName = Get-DefaultHostName
}

function Assert-BackendListening {
    param([int]$Port)
    $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $listening) {
        Write-Warning "Nothing is listening on 127.0.0.1:$Port. Set ADO_MCP_PORT=$Port in .env and run docker compose up -d first."
    }
}

function Assert-ListenPortFree {
    param([int]$Port, [string]$Name)

    Import-Module WebAdministration -ErrorAction SilentlyContinue
    $conflict = Get-Website -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -ne $Name -and ((Get-WebBinding -Name $_.Name -ErrorAction SilentlyContinue).bindingInformation -match ":${Port}:")
    }
    if ($conflict) {
        throw "IIS site '$($conflict.Name -join ', ')' already binds port $Port. Pick another -ListenPort."
    }

    $owner = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($owner -and -not (Get-Website -Name $Name -ErrorAction SilentlyContinue)) {
        Write-Warning "Port $Port already has a listener (PID $($owner.OwningProcess -join ', ')). Continuing, but the binding may fail to start."
    }
}

function Get-HttpsCertificate {
    param([string]$Name, [string]$ForcedThumbprint, [string]$IssuerMatch)

    $store = Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.HasPrivateKey }

    if ($ForcedThumbprint) {
        $match = $store | Where-Object { $_.Thumbprint -eq ($ForcedThumbprint -replace '\s', '') }
        if (-not $match) { throw "No cert in LocalMachine\My with thumbprint $ForcedThumbprint" }
        $picked = $match | Select-Object -First 1
        $eku = @($picked.EnhancedKeyUsageList | ForEach-Object { $_.FriendlyName })
        if ($eku.Count -gt 0 -and $eku -notcontains "Server Authentication") {
            throw "Cert $ForcedThumbprint has EKU '$($eku -join ', ')'. IIS HTTPS needs Server Authentication."
        }
        return $picked
    }

    $usable = foreach ($cert in $store) {
        $eku = @($cert.EnhancedKeyUsageList | ForEach-Object { $_.FriendlyName })
        $dns = @($cert.DnsNameList | ForEach-Object { $_.Unicode })
        $serverAuth = ($eku.Count -eq 0) -or ($eku -contains "Server Authentication")
        $nameHit = ($dns -contains $Name) -or ($cert.Subject -match [regex]::Escape($Name))
        $issuerHit = (-not $IssuerMatch) -or ($cert.Issuer -match [regex]::Escape($IssuerMatch))
        if ($serverAuth -and $nameHit -and $issuerHit) { $cert }
    }

    if ($usable) { return ($usable | Sort-Object NotAfter -Descending | Select-Object -First 1) }

    Write-Host "No cert matched HostName=$Name + Server Authentication$(if ($IssuerMatch) { " + Issuer $IssuerMatch" }). Candidates:" -ForegroundColor Yellow
    $store | ForEach-Object {
        [PSCustomObject]@{
            Subject    = $_.Subject
            Issuer     = $_.Issuer
            DnsNames   = ($_.DnsNameList | ForEach-Object { $_.Unicode }) -join ", "
            EKU        = ($_.EnhancedKeyUsageList | ForEach-Object { $_.FriendlyName }) -join ", "
            NotAfter   = $_.NotAfter
            Thumbprint = $_.Thumbprint
        }
    } | Format-List | Out-Host
    throw "Pass -Thumbprint, or request a Web Server cert for $Name, or drop -UseHttps and stay on HTTP."
}

function Test-IisModule {
    param([string]$Name)
    $null -ne (Get-WebGlobalModule -Name $Name -ErrorAction SilentlyContinue)
}

function Install-IisAndProxyModules {
    Write-Host "Installing IIS features (does not remove existing sites)..."
    Install-WindowsFeature Web-Server, Web-WebSockets, Web-Filtering, Web-Mgmt-Console | Out-Null

    Import-Module WebAdministration

    if ((Test-IisModule "RewriteModule") -and (Test-IisModule "ApplicationRequestRouting")) {
        Write-Host "URL Rewrite and ARR already installed."
        return
    }

    if ($SkipModuleInstall) {
        throw "URL Rewrite / ARR missing. Install them, or re-run without -SkipModuleInstall."
    }

    $temp = Join-Path $env:TEMP "iis-proxy-msi"
    New-Item -ItemType Directory -Path $temp -Force | Out-Null

    $packages = @(
        @{ Name = "rewrite"; Url = "https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi" },
        @{ Name = "arr"; Url = "https://download.microsoft.com/download/E/9/8/E9849D6A-020E-47E4-9FD0-A023E99B54EB/requestRouter_amd64.msi" }
    )

    foreach ($pkg in $packages) {
        $msi = Join-Path $temp "$($pkg.Name).msi"
        Write-Host "Downloading $($pkg.Name)..."
        Invoke-WebRequest -Uri $pkg.Url -OutFile $msi -UseBasicParsing
        Write-Host "Installing $($pkg.Name)..."
        $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
        if ($proc.ExitCode -notin 0, 3010) {
            throw "msiexec $($pkg.Name) exited $($proc.ExitCode). Install URL Rewrite 2.1 and ARR 3.0 from iis.net, then re-run."
        }
    }

    Import-Module WebAdministration -Force
    if (-not (Test-IisModule "RewriteModule") -or -not (Test-IisModule "ApplicationRequestRouting")) {
        throw "ARR/Rewrite still not visible to IIS. Reboot the VM and re-run this script."
    }
}

function Enable-ArrProxy {
    $filter = "system.webServer/proxy"
    $root = "MACHINE/WEBROOT/APPHOST"
    Set-WebConfigurationProperty -PSPath $root -Filter $filter -Name "enabled" -Value $true
    Set-WebConfigurationProperty -PSPath $root -Filter $filter -Name "preserveHostHeader" -Value $true
    Set-WebConfigurationProperty -PSPath $root -Filter $filter -Name "timeout" -Value "00:10:00"
}

function Write-ProxyWebConfig {
    param([string]$Path, [int]$Port)
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $config = @"
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <httpErrors existingResponse="PassThrough" />
    <rewrite>
      <rules>
        <rule name="ADO MCP reverse proxy" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:$Port/{R:1}" logRewrittenUrl="true" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
"@
    Set-Content -Path (Join-Path $Path "web.config") -Value $config -Encoding UTF8
}

function Install-McpSite {
    param(
        [string]$Name,
        [string]$Path,
        [int]$Port,
        [string]$HostHeader,
        [switch]$Https,
        [string]$CertThumbprint
    )

    Import-Module WebAdministration
    New-Item -ItemType Directory -Path $Path -Force | Out-Null

    if (Get-Website -Name $Name -ErrorAction SilentlyContinue) {
        Write-Host "Removing existing site $Name (other sites are untouched)..."
        Remove-Website -Name $Name
    }

    if ($Https) {
        New-Website -Name $Name -PhysicalPath $Path -Port $Port -HostHeader $HostHeader -Ssl | Out-Null
        Get-WebBinding -Name $Name | Remove-WebBinding
        New-WebBinding -Name $Name -Protocol https -Port $Port -IPAddress "*" -HostHeader $HostHeader -SslFlags 1

        $sslKey = "IIS:\SslBindings\0.0.0.0!$Port!$HostHeader"
        if (Test-Path $sslKey) { Remove-Item $sslKey }
        New-Item $sslKey -Thumbprint $CertThumbprint -SSLFlags 1 | Out-Null
    }
    else {
        New-Website -Name $Name -PhysicalPath $Path -Port $Port | Out-Null
    }
}

Assert-BackendListening -Port $BackendPort

if ($UseHttps -and -not $PSBoundParameters.ContainsKey("ListenPort")) { $ListenPort = 443 }
Assert-ListenPortFree -Port $ListenPort -Name $SiteName

Install-IisAndProxyModules
Enable-ArrProxy

$thumb = ""
if ($UseHttps) {
    $cert = Get-HttpsCertificate -Name $HostName -ForcedThumbprint $Thumbprint -IssuerMatch $IssuerFilter
    $thumb = $cert.Thumbprint
    Write-Host "Using cert:"
    Write-Host "  Subject    $($cert.Subject)"
    Write-Host "  Issuer     $($cert.Issuer)"
    Write-Host "  Dns        $((($cert.DnsNameList | ForEach-Object { $_.Unicode }) -join ', '))"
    Write-Host "  Thumbprint $($cert.Thumbprint)"
    Write-Host "  NotAfter   $($cert.NotAfter)"
}

Write-ProxyWebConfig -Path $PhysicalPath -Port $BackendPort
Install-McpSite -Name $SiteName -Path $PhysicalPath -Port $ListenPort -HostHeader $HostName -Https:$UseHttps -CertThumbprint $thumb
Start-Website -Name $SiteName

$scheme = if ($UseHttps) { "https" } else { "http" }
$publicHost = if ($HostName) { $HostName } else { Get-DefaultHostName }
$portSuffix = if (($UseHttps -and $ListenPort -eq 443) -or (-not $UseHttps -and $ListenPort -eq 80)) { "" } else { ":$ListenPort" }

Write-Host ""
Write-Host "IIS site '$SiteName' -> http://127.0.0.1:$BackendPort"
Write-Host "Other IIS sites were not modified."
Write-Host ""
Write-Host "Check:"
Write-Host "  curl.exe $scheme`://$publicHost$portSuffix/health"
Write-Host "  curl.exe http://127.0.0.1:$BackendPort/health"
Write-Host "Cursor via IIS:    $scheme`://$publicHost$portSuffix/mcp"
Write-Host "Cursor via IP:     $scheme`://<vm-ip>$portSuffix/mcp"
Write-Host "Docker loopback:   http://127.0.0.1:$BackendPort/mcp"
Write-Host ""
Write-Host "Firewall if needed:"
Write-Host "  New-NetFirewallRule -DisplayName 'ADO MCP $ListenPort' -Direction Inbound -Protocol TCP -LocalPort $ListenPort -Action Allow"
