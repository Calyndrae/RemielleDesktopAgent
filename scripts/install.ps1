# Remielle Desktop Agent — Windows installer
#
#   irm https://remielle.pages.dev/install.ps1 | iex
#
# Picks the right build for this machine, installs it under LocalAppData, and
# puts her in the Start Menu. No admin rights, no bundled binary: the download
# comes from the project's own GitHub release, so what you run is exactly what
# was published.

$ErrorActionPreference = 'Stop'
$repo = 'Calyndrae/RemielleDesktopAgent'
$dest = Join-Path $env:LOCALAPPDATA 'Remielle'

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
Write-Host "蕾米埃尔 · Remielle Desktop Agent"
Write-Host "  architecture: $arch"

$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" `
    -Headers @{ 'User-Agent' = 'remielle-installer' }
# Prefer the installer; fall back to a portable build for releases that shipped
# one. Both are per-user, so neither path ever asks for admin rights.
$asset = $release.assets | Where-Object { $_.name -like "*_$arch-setup.exe" } | Select-Object -First 1
$isSetup = [bool]$asset
if (-not $asset) {
    $asset = $release.assets | Where-Object { $_.name -like "*_$arch.exe" } | Select-Object -First 1
}
if (-not $asset) { throw "No $arch build in release $($release.tag_name)." }

Write-Host "  version:      $($release.tag_name)"
Write-Host "  downloading   $($asset.name) ($([math]::Round($asset.size/1MB,1)) MB)"

New-Item -ItemType Directory -Force -Path $dest | Out-Null
$exe = if ($isSetup) { Join-Path $env:TEMP $asset.name } else { Join-Path $dest 'Remielle Desktop Agent.exe' }
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exe -UseBasicParsing

# Checksums are published with every release; verifying here means a corrupted
# or tampered download fails loudly instead of launching.
$sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
if ($sums) {
    # One line per artifact; the architecture suffix identifies ours uniquely.
    $suffix = if ($isSetup) { "_$arch-setup\.exe" } else { "_$arch\.exe" }
    $line = (Invoke-WebRequest $sums.browser_download_url -UseBasicParsing).Content -split "`n" |
        Where-Object { $_ -match "$suffix\s*$" } | Select-Object -First 1
    if ($line) {
        $expected = ($line -split '\s+')[0].ToLower()
        $actual = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $expected) {
            Remove-Item $exe -Force
            throw "Checksum mismatch - download discarded. Expected $expected, got $actual."
        }
        Write-Host "  checksum      verified"
    }
}

# Clears the mark-of-the-web, so Windows does not treat a file this script just
# verified as an unknown download every time it launches.
Unblock-File $exe

# The installer already writes the Start Menu entry and launches her, so the
# script's own shortcut work below belongs only to the portable path.
if ($isSetup) {
    Write-Host ""
    Write-Host "  running installer…"
    Start-Process -FilePath $exe -Wait
    Write-Host "  installed     see the Start Menu for Remielle"
    return
}

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startMenu 'Remielle.lnk'))
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $dest
$shortcut.Description = 'Remielle Desktop Agent'
$shortcut.Save()

Write-Host ""
Write-Host "  installed to  $dest"
Write-Host "  start menu    Remielle"
Write-Host ""
Write-Host "Launching…"
Start-Process $exe
