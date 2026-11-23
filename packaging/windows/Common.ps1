$ErrorActionPreference = 'Stop'
$WorkbenchPort = 18788
$WorkbenchUrl = "http://127.0.0.1:$WorkbenchPort"

function Get-InstallRoot([string]$Root) {
    if (!$Root) { $Root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ZhaoxuHR' }
    return [IO.Path]::GetFullPath($Root)
}

function Read-JsonFile([string]$File) {
    return Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Read-InstallSelection([string]$Root) {
    $file = Join-Path $Root 'current.json'
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    $selection = Read-JsonFile $file
    if ($selection.version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$' -or
        $selection.installId -notmatch '^[0-9a-f]{32}$' -or
        ($selection.previousVersion -and $selection.previousVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$')) {
        throw 'The installed version information is invalid.'
    }
    return $selection
}

function Get-InstalledApp([string]$Root, $Selection) {
    if (!$Selection) { throw 'Zhaoxu HR is not installed. Run Install.cmd first.' }
    return Join-Path (Join-Path $Root 'versions') $Selection.version
}

function Get-WorkbenchHealth {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        try { $client.Connect([Net.IPAddress]::Loopback, $WorkbenchPort) }
        catch {
            if ($_.Exception.GetBaseException().SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) { return $null }
            throw
        }
    } finally { $client.Dispose() }
    try { return Invoke-RestMethod -Uri "$WorkbenchUrl/api/health" -TimeoutSec 3 }
    catch { throw "Port $WorkbenchPort is occupied or the workbench is still starting. Try again after the service is ready." }
}

function Assert-OwnedWorkbench($Health, $Selection) {
    if (!$Health) { return }
    if (!$Selection -or $Health.ok -ne $true -or $Health.installId -cne $Selection.installId -or
        $Health.version -cne $Selection.version) {
        throw "Port $WorkbenchPort is occupied by another instance. It was not changed."
    }
}

function Use-WorkbenchRuntime([string]$Root, [string]$App, $Selection) {
    $env:HR_HOME = $Root
    $env:HR_PORT = [string]$WorkbenchPort
    $env:HR_INSTALL_ID = [string]$Selection.installId
    $env:HR_PYTHON = Join-Path $App 'vendor\python\python.exe'
}

function Invoke-WorkbenchService([string]$Root, [string]$App, $Selection, [switch]$Stop) {
    $node = Join-Path $App 'vendor\node\node.exe'
    $entry = Join-Path $App 'scripts\background-workbench.mjs'
    if (!(Test-Path -LiteralPath $node -PathType Leaf) -or !(Test-Path -LiteralPath $entry -PathType Leaf)) {
        throw 'An installed runtime file is missing. Run the installer to restore the program.'
    }
    Use-WorkbenchRuntime $Root $App $Selection
    if ($Stop) { & $node $entry --local-service --stop }
    else { & $node $entry --local-service }
    if ($LASTEXITCODE -ne 0) { throw 'The workbench service command failed. See runtime/server.log in the installation folder.' }
}

function Set-FileAtomically([string]$File, [string]$Source, [string]$Value) {
    $temp = "$File.$([Guid]::NewGuid().ToString('N')).tmp"
    $backup = "$temp.backup"
    try {
        if ($Source) { [IO.File]::Copy($Source, $temp) }
        else { [IO.File]::WriteAllText($temp, $Value, [Text.UTF8Encoding]::new($false)) }
        if ([IO.File]::Exists($File)) { [IO.File]::Replace($temp, $File, $backup) }
        else { [IO.File]::Move($temp, $File) }
    } finally {
        [IO.File]::Delete($temp)
        [IO.File]::Delete($backup)
    }
}
