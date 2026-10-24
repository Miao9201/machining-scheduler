$env:PSModulePath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\Modules"
$ErrorActionPreference = 'Stop'
$appDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverFile = [System.IO.Path]::GetFullPath((Join-Path $appDirectory 'src\server.js'))
foreach ($launchPort in @(18787, 18788)) {
    $listeners = Get-NetTCPConnection -State Listen -LocalPort $launchPort -ErrorAction SilentlyContinue
    foreach ($listener in $listeners) {
        $serviceProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        if ($serviceProcess.Name -eq 'node.exe' -and $serviceProcess.CommandLine -match [regex]::Escape($serverFile)) {
            Stop-Process -Id $serviceProcess.ProcessId
        }
    }
}
