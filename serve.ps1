# serve.ps1
$root = "C:\Users\paulb\OneDrive\Desktop\Beneath Open Roads\Tool PokeMMO"
$port = 8000
$url  = "http://localhost:$port/"

if (!(Test-Path $root)) { throw "Folder not found: $root" }

Set-Location $root
Write-Host "Starting server at $url" -ForegroundColor Green
Start-Process $url

# Prefer py, fallback to python
try {
  py -m http.server $port
} catch {
  python -m http.server $port
}