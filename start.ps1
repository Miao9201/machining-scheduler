param([switch]$Demo)
$env:PSModulePath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\Modules"
$ErrorActionPreference = 'Stop'
$appDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$launchPort = if ($Demo) { 18788 } else { 18787 }
$dataDirectory = Join-Path $appDirectory $(if ($Demo) { 'data-demo' } else { 'data' })
$appUrl = "http://127.0.0.1:$launchPort"
try {
    $running = $null
    try { $running = Invoke-RestMethod -Uri "$appUrl/api/overview" -TimeoutSec 2 } catch { }
    if ($running -and $running.appId -eq 'machining-scheduler') {
        Start-Process $appUrl
        exit 0
    }
    if ($running) { throw "Port $launchPort is already used by another application." }
    $nodeRuntime = Join-Path $appDirectory 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $nodeRuntime)) {
        $nodeRuntime = (Get-Command node.exe -ErrorAction Stop).Source
    }
    $nodeVersion = & $nodeRuntime --version
    if ([int](($nodeVersion.TrimStart('v')).Split('.')[0]) -lt 24) { throw 'Node.js 24 or later is required.' }
    New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
    $env:DATA_DIR = $dataDirectory
    $env:PORT = $launchPort
    $serverFile = Join-Path $appDirectory 'src\server.js'
    $nodeArguments = '"' + $serverFile + '"' + $(if ($Demo) { ' --demo' } else { '' })
    $serviceProcess = Start-Process -FilePath $nodeRuntime -ArgumentList $nodeArguments -WorkingDirectory $appDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDirectory 'server-stdout.log') -RedirectStandardError (Join-Path $dataDirectory 'server-stderr.log') -PassThru
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $ready = Invoke-RestMethod -Uri "$appUrl/api/overview" -TimeoutSec 1
            if ($ready.appId -eq 'machining-scheduler') {
                Start-Process $appUrl
                exit 0
            }
        } catch { }
        if ($serviceProcess.HasExited) { break }
    }
    throw "Application did not start. See logs in $dataDirectory"
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Machining Scheduler') | Out-Null
    exit 1
}
