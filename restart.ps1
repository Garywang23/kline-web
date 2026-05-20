# 停掉占用 8787 的进程
$procs = Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
if ($procs) { $procs | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }

# 兜底：停掉所有跑 dashboard_server.mjs 的 node 进程
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'dashboard_server\.mjs' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Sleep -Milliseconds 800

Start-Process -FilePath node -ArgumentList 'D:\Cline\kline-web\dashboard_server.mjs' -WorkingDirectory 'D:\Cline\kline-web' -WindowStyle Hidden
Start-Sleep -Seconds 2

try {
  $code = (Invoke-WebRequest 'http://127.0.0.1:8787/api/snapshot' -UseBasicParsing -TimeoutSec 15).StatusCode
  Write-Host "OK $code  http://127.0.0.1:8787/"
} catch {
  Write-Host "FAIL $($_.Exception.Message)"
}
