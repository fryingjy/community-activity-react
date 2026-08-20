$ErrorActionPreference = "Stop"

$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chromeExecutable = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $chromeExecutable) {
  Write-Error "Google Chrome was not found in a standard installation folder."
}

if (Get-Process -Name chrome -ErrorAction SilentlyContinue) {
  Write-Host "Close every Chrome window first, then run this launcher again." -ForegroundColor Yellow
  Write-Host "Chrome only reads background-throttling flags when its first process starts."
  exit 1
}

$launchArguments = @(
  "--new-window",
  "--disable-backgrounding-occluded-windows",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "https://x.com/home"
)

Write-Host "Starting Chrome with renderer background throttling disabled for this session..."
Start-Process -FilePath $chromeExecutable -ArgumentList $launchArguments
