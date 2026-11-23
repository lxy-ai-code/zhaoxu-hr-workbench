param([switch]$Stop, [switch]$OpenBoss)

. (Join-Path $PSScriptRoot 'Common.ps1')
if ($Stop -and $OpenBoss) { throw 'Stop and OpenBoss cannot be used together.' }
$lock = [IO.File]::Open((Join-Path $PSScriptRoot 'install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $selection = Read-InstallSelection $PSScriptRoot
    $app = Get-InstalledApp $PSScriptRoot $selection
    $health = Get-WorkbenchHealth
    Assert-OwnedWorkbench $health $selection
    if ($OpenBoss) {
        Use-WorkbenchRuntime $PSScriptRoot $app $selection
        & (Join-Path $app 'vendor\node\node.exe') (Join-Path $app 'scripts\background-workbench.mjs') --open-boss
        if ($LASTEXITCODE -ne 0) { throw 'The dedicated BOSS login browser could not start.' }
    } else {
        Invoke-WorkbenchService $PSScriptRoot $app $selection -Stop:$Stop
        if (!$Stop) {
            $health = Get-WorkbenchHealth
            if (!$health) { throw 'The workbench did not reach a healthy state.' }
            Assert-OwnedWorkbench $health $selection
            Start-Process $WorkbenchUrl
        }
    }
} finally { $lock.Dispose() }
