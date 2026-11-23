[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'ZhaoxuHR'),
    [string]$Repository = '',
    [string]$ExpectedVersion,
    [string]$StatusFile,
    [switch]$NoLaunch
)

. (Join-Path $PSScriptRoot 'Common.ps1')
$versionPattern = '(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2}'
$repoPattern = '^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}/[a-zA-Z0-9_.-]{1,100}$'

function Save-PublicGitHubFile($Client, [uri]$Uri, [string]$Destination, [long]$Limit, [int]$Seconds, [switch]$Asset) {
    $hosts = if ($Asset) { @('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com') } else { @('api.github.com') }
    $deadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($Seconds))
    try {
        for ($redirects = 0; $redirects -le 4; $redirects++) {
            if (!$Uri.IsAbsoluteUri -or $Uri.Scheme -cne 'https' -or !$Uri.IsDefaultPort -or $Uri.UserInfo -or $Uri.Host -notin $hosts) {
                throw 'The release URL is outside the permitted GitHub download hosts.'
            }
            $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $Uri)
            $accept = if ($Asset) { 'application/octet-stream' } else { 'application/vnd.github+json' }
            $request.Headers.Accept.ParseAdd($accept)
            try {
                $response = $Client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $deadline.Token).GetAwaiter().GetResult()
                try {
                    $status = [int]$response.StatusCode
                    if ($Asset -and $status -in 301, 302, 303, 307, 308 -and $response.Headers.Location) {
                        $Uri = [uri]::new($Uri, $response.Headers.Location)
                        continue
                    }
                    if ($status -ne 200) { throw "GitHub returned HTTP $status." }
                    if ($response.Content.Headers.ContentLength -gt $Limit) { throw 'The GitHub response exceeds the expected download size.' }
                    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
                    try {
                        $file = [IO.File]::Open($Destination, 'CreateNew', 'Write', 'None')
                        try {
                            $buffer = [byte[]]::new(65536)
                            $written = 0L
                            while (($read = $stream.ReadAsync($buffer, 0, $buffer.Length, $deadline.Token).GetAwaiter().GetResult()) -gt 0) {
                                $written += $read
                                if ($written -gt $Limit) { throw 'The GitHub response exceeds the expected download size.' }
                                $file.Write($buffer, 0, $read)
                            }
                        } finally { $file.Dispose() }
                    } finally { $stream.Dispose() }
                    return
                } finally { $response.Dispose() }
            } finally { $request.Dispose() }
        }
        throw 'GitHub returned too many download redirects.'
    } finally { $deadline.Dispose() }
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

$InstallRoot = Get-InstallRoot $InstallRoot
$windowUpdate = [bool]$StatusFile
$runtime = Join-Path $InstallRoot 'runtime'
$canonicalStatus = Join-Path $runtime 'update-status.json'
if ($windowUpdate -and (![IO.Path]::IsPathRooted($StatusFile) -or [IO.Path]::GetFullPath($StatusFile) -ine $canonicalStatus)) {
    throw 'The update status file must belong to this installation.'
}
if ($ExpectedVersion -and $ExpectedVersion -cnotmatch "^$versionPattern$") {
    throw 'The requested update version is invalid.'
}
$pointerPath = Join-Path $InstallRoot 'current.json'
if (!(Test-Path -LiteralPath $pointerPath -PathType Leaf)) { throw 'Install Zhaoxu HR before checking for updates.' }

function Update-ProgressFile([string]$Status, [string]$Version, [string]$Stage, [string]$Failure) {
    $value = [ordered]@{
        status = $Status
        version = $Version
        stage = $Stage
        updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    }
    if ($Status -ceq 'running') { $value.processId = $PID }
    if ($Failure) { $value.error = $Failure }
    $encoded = $value | ConvertTo-Json -Compress
    for ($attempt = 0; ; $attempt++) {
        try { Set-FileAtomically -File $canonicalStatus -Value $encoded; return }
        catch [IO.IOException] {
            if ($attempt -ge 3) { throw }
            Start-Sleep -Milliseconds (100 * ($attempt + 1))
        }
    }
}

[IO.Directory]::CreateDirectory($runtime) | Out-Null
$lock = [IO.File]::Open((Join-Path $runtime 'update.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$newVersion = $ExpectedVersion
$step = 'checking'
$temp = $null
$client = $null
try {
    $current = Read-InstallSelection $InstallRoot
    if ($current.version -notmatch "^$versionPattern$") { throw 'The installed version is invalid. Run the original installer again.' }
    if (!$newVersion) { $newVersion = $current.version }
    Update-ProgressFile 'running' $newVersion $step
    $manifest = Read-JsonFile (Join-Path $InstallRoot "versions/$($current.version)/package-info.json")
    if ($manifest.version -cne $current.version) { throw 'The installed package information does not match the active version.' }
    if (!$Repository) { $Repository = $manifest.repository }
    if ($manifest.repository -and $Repository -ne $manifest.repository) { throw 'The update repository differs from the installed release channel.' }
    if ($Repository -notmatch $repoPattern -or $Repository.Split('/')[1] -in '.', '..') {
        throw 'The release repository is missing or invalid. Install a version published for your GitHub repository.'
    }
    $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $temp = [IO.Path]::GetFullPath((Join-Path $tempParent ('ZhaoxuHR-update-' + [Guid]::NewGuid().ToString('N'))))
    [IO.Directory]::CreateDirectory($temp) | Out-Null
    Add-Type -AssemblyName System.Net.Http
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('Zhaoxu-HR-Updater/1.1')
    $client.DefaultRequestHeaders.Add('X-GitHub-Api-Version', '2022-11-28')
    $metadata = Join-Path $temp 'release.json'
    Save-PublicGitHubFile $client "https://api.github.com/repos/$Repository/releases/latest" $metadata 1MB 15
    $release = Read-JsonFile $metadata
    if ($release.draft -ne $false -or $release.prerelease -ne $false -or $release.tag_name -cnotmatch "^v($versionPattern)$") {
        throw 'The latest GitHub release is not a stable Zhaoxu HR version.'
    }
    $releasedVersion = $release.tag_name.Substring(1)
    if ($ExpectedVersion -and $releasedVersion -cne $ExpectedVersion) {
        throw 'The latest version changed. Open the workbench again and check for updates.'
    }
    if ([version]$releasedVersion -le [version]$current.version) {
        Update-ProgressFile 'succeeded' $current.version $step
        Write-Host "Zhaoxu HR $($current.version) is up to date."
        return
    }
    $newVersion = $releasedVersion
    $zipName = "ZhaoxuHR-$($release.tag_name)-windows-x64.zip"
    $checksumName = "$zipName.sha256"
    $asset = @($release.assets | Where-Object name -CEQ $zipName)
    $checksum = @($release.assets | Where-Object name -CEQ $checksumName)
    $downloadBase = "https://github.com/$Repository/releases/download/$($release.tag_name)"
    if ($asset.Count -ne 1 -or $checksum.Count -ne 1 -or $asset[0].state -cne 'uploaded' -or $checksum[0].state -cne 'uploaded' -or
        $asset[0].size -lt 1 -or $asset[0].size -gt 500MB -or $checksum[0].size -lt 1 -or $checksum[0].size -gt 1024 -or
        $asset[0].browser_download_url -cne "$downloadBase/$zipName" -or $checksum[0].browser_download_url -cne "$downloadBase/$checksumName") {
        throw 'The release is missing the expected Windows package or checksum.'
    }

    $step = 'downloading'
    Update-ProgressFile 'running' $newVersion $step
    Write-Host "Downloading Zhaoxu HR $newVersion ..."
    $zipPath = Join-Path $temp $zipName
    $checksumPath = Join-Path $temp $checksumName
    Save-PublicGitHubFile $client "$downloadBase/$checksumName" $checksumPath $checksum[0].size 30 -Asset
    Save-PublicGitHubFile $client "$downloadBase/$zipName" $zipPath $asset[0].size 300 -Asset

    $step = 'verifying'
    Update-ProgressFile 'running' $newVersion $step
    if ((Get-Item -LiteralPath $zipPath).Length -ne $asset[0].size -or (Get-Item -LiteralPath $checksumPath).Length -ne $checksum[0].size) {
        throw 'The downloaded release files have unexpected sizes.'
    }
    if ($checksum[0].digest -and $checksum[0].digest -ne "sha256:$((Get-FileHash -LiteralPath $checksumPath -Algorithm SHA256).Hash)") {
        throw 'The downloaded checksum file did not match GitHub release metadata.'
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
            throw 'The package version or repository does not match the public release channel.'
        }
    }
    $installer = Join-Path $stage 'Install.ps1'
    if (!(Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'The Windows installer is missing from the release package.' }
    $active = Read-JsonFile $pointerPath
    if ($active.version -cne $current.version) { throw 'The installed version changed during download. Run Check for updates again.' }

    $step = 'installing'
    Update-ProgressFile 'running' $newVersion $step
    $installArguments = @{ InstallRoot = $InstallRoot }
    if ($NoLaunch) {
        $installArguments.NoLaunch = $true
        $installArguments.NoShortcut = $true
    } elseif ($windowUpdate) {
        $installArguments.NoBrowser = $true
    }
    & $installer @installArguments
    Update-ProgressFile 'succeeded' $newVersion $step
} catch {
    $failure = switch ($step) {
        'checking' { 'The public GitHub release could not be checked. Check your network and try again.' }
        'downloading' { 'The download failed. Check your network and try again.' }
        'verifying' { 'The downloaded update did not pass verification. Try checking again later.' }
        'installing' { 'The update could not be installed. Close active work and try again.' }
    }
    Update-ProgressFile 'failed' $newVersion $step $failure
    throw
} finally {
    if ($client) { $client.Dispose() }
    if ($temp -and (Split-Path -Parent ([IO.Path]::GetFullPath($temp))) -ieq $tempParent.TrimEnd('\') -and
        (Split-Path -Leaf $temp) -match '^ZhaoxuHR-update-[0-9a-f]{32}$' -and (Test-Path -LiteralPath $temp -PathType Container)) {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
    $lock.Dispose()
}
