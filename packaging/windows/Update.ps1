[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'ZhaoxuHR'),
    [string]$Repository = '',
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$versionPattern = '(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2}'
$repoPattern = '^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}/[a-zA-Z0-9_.-]{1,100}$'

function Read-JsonFile([string]$Path) {
    Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Expand-ReleasePackage([string]$ZipPath, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $prefix = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $expandedSize = 0L
    $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        if ($archive.Entries.Count -gt 20000) { throw 'The release package contains too many files.' }
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            $directory = $name.EndsWith('/')
            $relative = $name.TrimEnd('/')
            if ($relative -cnotmatch '^(?:(?:Boss|Install|Start|Stop|Update)\.cmd|(?:Common|Install|Start|Update)\.ps1|package-info\.json|app(?:/(?:package-info\.json|server\.mjs|package\.json|(?:lib|public|scripts|vendor)(?:/.+)?))?)$') {
                throw 'The release package contains an unexpected path.'
            }
            foreach ($part in $relative.Split('/')) {
                if ($part -in '', '.', '..' -or $part -match '[\x00-\x1f<>:"|?*]|[. ]$|^(?:AUX|CON|NUL|PRN|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)') {
                    throw 'The release package contains an unsafe Windows path.'
                }
            }
            $target = [IO.Path]::GetFullPath((Join-Path $Destination $relative))
            if (!$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or !$paths.Add($target)) {
                throw 'The release package contains an unsafe or duplicate path.'
            }
            if (($entry.ExternalAttributes -band 0x400) -or (($entry.ExternalAttributes -shr 16) -band 0xf000) -eq 0xa000) {
                throw 'The release package contains an unsafe file link.'
            }
            $expandedSize += $entry.Length
            if ($expandedSize -gt 1GB) { throw 'The expanded release package is larger than expected.' }
            if ($directory) {
                [void][IO.Directory]::CreateDirectory($target)
            } else {
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
            }
        }
    } finally {
        $archive.Dispose()
    }
}

$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$pointerPath = Join-Path $InstallRoot 'current.json'
if (!(Test-Path -LiteralPath $pointerPath -PathType Leaf)) { throw 'Install Zhaoxu HR before checking for updates.' }
$current = Read-JsonFile $pointerPath
if ($current.version -notmatch "^$versionPattern$") { throw 'The installed version is invalid. Run the original installer again.' }
$manifest = Read-JsonFile (Join-Path $InstallRoot "versions/$($current.version)/package-info.json")
if ($manifest.version -cne $current.version) { throw 'The installed package information does not match the active version.' }
if (!$Repository) { $Repository = $manifest.repository }
if ($manifest.repository -and $Repository -ne $manifest.repository) { throw 'The update repository differs from the installed release channel.' }
if ($Repository -notmatch $repoPattern -or $Repository.Split('/')[1] -in '.', '..') {
    throw 'The release repository is missing or invalid. Install a version published for your GitHub repository.'
}

$gh = Get-Command gh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$gh) { throw 'Install GitHub CLI first (https://cli.github.com/), then run gh auth login --hostname github.com.' }
$releaseJson = & $gh.Source release view --repo $Repository --json tagName,isDraft,isPrerelease,assets
if ($LASTEXITCODE -ne 0) { throw 'Cannot read the release. Run gh auth login --hostname github.com with a GitHub account that can read the private repository.' }
$release = $releaseJson | ConvertFrom-Json
if ($release.isDraft -ne $false -or $release.isPrerelease -ne $false -or $release.tagName -cnotmatch "^v($versionPattern)$") {
    throw 'The latest GitHub release is not a stable Zhaoxu HR version.'
}
$newVersion = $release.tagName.Substring(1)
if ([version]$newVersion -le [version]$current.version) {
    Write-Host "Zhaoxu HR $($current.version) is up to date."
    return
}

$zipName = "ZhaoxuHR-$($release.tagName)-windows-x64.zip"
$checksumName = "$zipName.sha256"
$asset = @($release.assets | Where-Object name -CEQ $zipName)
$checksum = @($release.assets | Where-Object name -CEQ $checksumName)
if ($asset.Count -ne 1 -or $checksum.Count -ne 1 -or $asset[0].size -lt 1 -or $asset[0].size -gt 500MB -or $checksum[0].size -lt 1 -or $checksum[0].size -gt 1024) {
    throw 'The release is missing the expected Windows package or checksum.'
}

$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$temp = [IO.Path]::GetFullPath((Join-Path $tempParent ('ZhaoxuHR-update-' + [Guid]::NewGuid().ToString('N'))))
if (!$temp.StartsWith($tempParent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid update staging path.' }
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    Write-Host "Downloading Zhaoxu HR $newVersion ..."
    & $gh.Source release download $release.tagName --repo $Repository --pattern $zipName --pattern $checksumName --dir $temp
    if ($LASTEXITCODE -ne 0) { throw 'The release download failed. Check your GitHub access and internet connection.' }
    $zipPath = Join-Path $temp $zipName
    $checksumPath = Join-Path $temp $checksumName
    if ((Get-Item -LiteralPath $zipPath).Length -ne $asset[0].size -or (Get-Item -LiteralPath $checksumPath).Length -ne $checksum[0].size) {
        throw 'The downloaded release files have unexpected sizes.'
    }
    $hashLine = (Get-Content -LiteralPath $checksumPath -Raw -Encoding UTF8).Trim()
    if ($hashLine -notmatch ('^([a-fA-F0-9]{64})(?:[ \t]+\*?' + [regex]::Escape($zipName) + ')?$')) {
        throw 'The downloaded release checksum is invalid.'
    }
    $expectedDigest = $Matches[1]
    $digest = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
    if ($digest -ne $expectedDigest -or ($asset[0].digest -and $asset[0].digest -ne "sha256:$digest")) {
        throw 'The Windows package did not match the published SHA-256 checksum.'
    }

    $stage = Join-Path $temp 'package'
    Expand-ReleasePackage $zipPath $stage
    foreach ($manifestPath in @('package-info.json', 'app/package-info.json')) {
        $downloaded = Read-JsonFile (Join-Path $stage $manifestPath)
        if ($downloaded.version -cne $newVersion -or $downloaded.repository -ne $Repository) {
            throw 'The package version or repository does not match the signed-in release channel.'
        }
    }
    $installer = Join-Path $stage 'Install.ps1'
    if (!(Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'The Windows installer is missing from the release package.' }
    $active = Read-JsonFile $pointerPath
    if ($active.version -cne $current.version) { throw 'The installed version changed during download. Run Check for updates again.' }
    & $installer -InstallRoot $InstallRoot -NoLaunch:$NoLaunch
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
