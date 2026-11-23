param(
    [string]$InstallRoot,
    [switch]$NoLaunch,
    [switch]$NoShortcut
)

. (Join-Path $PSScriptRoot 'Common.ps1')
if (![Environment]::Is64BitOperatingSystem) { throw 'This installer requires 64-bit Windows.' }

function Read-Package([string]$App) {
    foreach ($file in @('server.mjs', 'package.json', 'scripts\background-workbench.mjs', 'vendor\node\node.exe', 'vendor\python\python.exe')) {
        if (!(Test-Path -LiteralPath (Join-Path $App $file) -PathType Leaf)) { throw "The program package is missing $file." }
    }
    foreach ($folder in @('data', 'runtime', 'artifacts', '.chrome-cdp-9222', '.env', '.env.local')) {
        if (Test-Path -LiteralPath (Join-Path $App $folder)) { throw "A program package cannot contain $folder." }
    }
    $release = Read-JsonFile (Join-Path $App 'package-info.json')
    $program = Read-JsonFile (Join-Path $App 'package.json')
    if ($release.version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$' -or $release.version -cne $program.version -or
        ($release.repository -and $release.repository -notmatch '^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$')) {
        throw 'The program version or release repository is invalid.'
    }
    return $release
}

function Assert-WorkbenchIdle {
    $workspace = Invoke-RestMethod -Uri "$WorkbenchUrl/api/workspace" -TimeoutSec 12
    foreach ($status in @($workspace.inboxStatus, $workspace.liveCaptureStatus, $workspace.copilotStatus, $workspace.interviewReportStatus)) {
        if ($status.running -or $status.status -in @('running', 'capturing', 'analyzing')) {
            throw 'Background work is in progress. Retry the update after it finishes.'
        }
    }
    if ($workspace.jobs | Where-Object { $_.status -eq 'running' }) {
        throw 'A workbench task is running. Retry the update after it finishes.'
    }
    $now = [DateTimeOffset]::UtcNow
    $soon = $now.AddMinutes(5)
    foreach ($interview in $workspace.interviews) {
        if ($interview.autoJoin.status -eq 'joining' -or
            $interview.reminder.status -eq 'sending' -or $interview.reminder.testReceipt.status -eq 'sending' -or
            ($interview.notifications.deliveries | Where-Object { $_.status -eq 'sending' })) {
            throw 'An interview action is in progress. Retry the update after it finishes.'
        }
        if ($interview.status -eq 'cancelled' -or !$interview.startAt -or !$interview.endAt) { continue }
        $start = [DateTimeOffset]$interview.startAt
        $end = [DateTimeOffset]$interview.endAt
        if ($end -gt $now -and $start -le $soon) {
            throw 'There is an interview in progress or starting soon. Retry the update after it finishes.'
        }
        if ($end -gt $now -and $interview.reminder.status -eq 'scheduled' -and
            $interview.reminder.dueAt -and ([DateTimeOffset]$interview.reminder.dueAt) -le $soon) {
            throw 'An interview reminder is due soon. Retry the update after it is sent.'
        }
    }
}

function Assert-WorkbenchNotStarting([string]$InstallDirectory, $Health) {
    if ($Health) { return }
    $supervisorLock = Join-Path $InstallDirectory 'runtime\background-service.lock.json'
    if (!(Test-Path -LiteralPath $supervisorLock -PathType Leaf)) { return }
    $owner = Read-JsonFile $supervisorLock
    if ($owner.pid -gt 0 -and $owner.startedAt) {
        $process = Get-Process -Id $owner.pid -ErrorAction SilentlyContinue
        if ($process -and $process.ProcessName -eq 'node' -and
            $process.StartTime.ToUniversalTime() -le ([DateTimeOffset]$owner.startedAt).UtcDateTime.AddSeconds(2)) {
            throw 'The workbench is starting or restarting. Retry after it is ready.'
        }
    }
}

function New-WorkbenchShortcut([string]$Folder, [string]$Name, [string]$Target) {
    if (!$Folder -or !(Test-Path -LiteralPath $Folder -PathType Container)) { return }
    $link = Join-Path $Folder "$Name.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($link)
    if ((Test-Path -LiteralPath $link) -and $shortcut.TargetPath -ine $Target) { return }
    $shortcut.TargetPath = $Target
    $shortcut.WorkingDirectory = $root
    $shortcut.Save()
}

$root = Get-InstallRoot $InstallRoot
$payload = Join-Path $PSScriptRoot 'app'
$incoming = Read-Package $payload
if ([IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') -ieq $root.TrimEnd('\')) {
    throw 'Unzip or start the installer from a folder outside the installation folder.'
}
[IO.Directory]::CreateDirectory($root) | Out-Null
$lock = [IO.File]::Open((Join-Path $root 'install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $old = Read-InstallSelection $root
    $health = Get-WorkbenchHealth
    Assert-OwnedWorkbench $health $old
    $versions = Join-Path $root 'versions'
    $destination = Join-Path $versions $incoming.version
    if ($old) {
        if ([version]$incoming.version -lt [version]$old.version) { throw 'A newer version is already installed.' }
        $previousApp = Get-InstalledApp $root $old
        $previousPackage = Read-JsonFile (Join-Path $previousApp 'package-info.json')
        if ($previousPackage.repository -and $incoming.repository -ine $previousPackage.repository) {
            throw 'This installer belongs to a different release repository.'
        }
    }
    [IO.Directory]::CreateDirectory($versions) | Out-Null
    if (!(Test-Path -LiteralPath $destination)) {
        $stage = Join-Path $versions ".staging-$([Guid]::NewGuid().ToString('N'))"
        try {
            Copy-Item -LiteralPath $payload -Destination $stage -Recurse
            $null = Read-Package $stage
            [IO.Directory]::Move($stage, $destination)
        } finally {
            if ((Split-Path -Parent ([IO.Path]::GetFullPath($stage))) -ieq $versions -and
                (Split-Path -Leaf $stage) -match '^\.staging-[0-9a-f]{32}$' -and (Test-Path -LiteralPath $stage)) {
                Remove-Item -LiteralPath $stage -Recurse -Force
            }
        }
    }
    $stored = Read-Package $destination
    if ($stored.version -cne $incoming.version -or $stored.repository -ine $incoming.repository) {
        throw 'A different package already occupies this version. Publish it with a new version number.'
    }
    $selection = if ($old -and $old.version -eq $incoming.version) { $old } else {
        [pscustomobject]@{
            version = $incoming.version
            previousVersion = if ($old) { $old.version } else { $null }
            installId = if ($old) { $old.installId } else { [Guid]::NewGuid().ToString('N') }
        }
    }
    $health = Get-WorkbenchHealth
    Assert-OwnedWorkbench $health $old
    Assert-WorkbenchNotStarting $root $health
    $stoppedForUpgrade = $false
    $selectionChanged = !$old -or $old.version -ne $selection.version
    $activated = $false
    try {
        if ($health -and $selectionChanged) {
            Assert-WorkbenchIdle
            Invoke-WorkbenchService $root $previousApp $old -Stop
            $stoppedForUpgrade = $true
            if (Get-WorkbenchHealth) { throw 'The old workbench is still running. Retry after it stops.' }
        }
        if ($old -and $selectionChanged) {
            $workspaceFile = Join-Path $root 'data\workspace.json'
            if (Test-Path -LiteralPath $workspaceFile -PathType Leaf) {
                $backupFolder = Join-Path $root 'backups'
                [IO.Directory]::CreateDirectory($backupFolder) | Out-Null
                $backupName = "workspace-before-$($selection.version)-$([Guid]::NewGuid().ToString('N')).json"
                [IO.File]::Copy($workspaceFile, (Join-Path $backupFolder $backupName))
            }
        }
        foreach ($file in @('Common.ps1', 'Start.ps1', 'Start.cmd', 'Stop.cmd', 'Boss.cmd', 'Update.ps1', 'Update.cmd')) {
            $source = Join-Path $PSScriptRoot $file
            Set-FileAtomically -File (Join-Path $root $file) -Source $source
        }
        $current = Join-Path $root 'current.json'
        if ($selectionChanged) {
            Set-FileAtomically -File $current -Value ($selection | ConvertTo-Json -Compress)
            $activated = $true
        }
        if (!$NoLaunch) {
            Invoke-WorkbenchService $root $destination $selection
            $health = Get-WorkbenchHealth
            if (!$health) { throw 'The installed workbench did not start.' }
            Assert-OwnedWorkbench $health $selection
        }
    } catch {
        $failure = $_
        if ($activated -and $old) {
            try {
                Invoke-WorkbenchService $root $destination $selection -Stop
                Set-FileAtomically -File $current -Value ($old | ConvertTo-Json -Compress)
            } catch {
                throw "Version $($selection.version) could not start and automatic rollback failed. Backup data is in $root\backups. $($_.Exception.Message)"
            }
        }
        if ($stoppedForUpgrade) { Invoke-WorkbenchService $root $previousApp $old }
        throw $failure
    }
} finally { $lock.Dispose() }

if (!$NoShortcut) {
    $programs = [Environment]::GetFolderPath('Programs')
    New-WorkbenchShortcut $programs 'Zhaoxu HR' (Join-Path $root 'Start.cmd')
    New-WorkbenchShortcut $programs 'Zhaoxu HR Update' (Join-Path $root 'Update.cmd')
    New-WorkbenchShortcut $programs 'Zhaoxu HR Stop' (Join-Path $root 'Stop.cmd')
    New-WorkbenchShortcut $programs 'Zhaoxu HR BOSS Login' (Join-Path $root 'Boss.cmd')
    New-WorkbenchShortcut ([Environment]::GetFolderPath('DesktopDirectory')) 'Zhaoxu HR' (Join-Path $root 'Start.cmd')
}
Write-Host "Zhaoxu HR $($incoming.version) installed in $root."
if (!$NoLaunch) { Start-Process $WorkbenchUrl }
