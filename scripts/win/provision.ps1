# Remielle Windows build VM provisioning. Logs every stage to C:\provision.log.
$ErrorActionPreference = 'Continue'
$log = 'C:\provision.log'
function Stage($m) { "$(Get-Date -Format HH:mm:ss) $m" | Out-File -Append -Encoding ascii $log }

Stage 'provision start'
$dl = 'C:\provision'
New-Item -ItemType Directory -Force -Path $dl | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# --- Visual Studio Build Tools: MSVC for ARM64 + x64, lean workload ---
if (-not (Test-Path 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC')) {
  Stage 'downloading vs_BuildTools bootstrapper'
  Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vs_BuildTools.exe' -OutFile "$dl\vs_BuildTools.exe"
  Stage 'installing VS Build Tools (this is the long one)'
  $p = Start-Process -FilePath "$dl\vs_BuildTools.exe" -ArgumentList @(
    '--quiet','--wait','--norestart','--nocache',
    '--add','Microsoft.VisualStudio.Workload.VCTools',
    '--add','Microsoft.VisualStudio.Component.VC.Tools.ARM64',
    '--add','Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '--add','Microsoft.VisualStudio.Component.Windows11SDK.22621'
  ) -Wait -PassThru
  Stage "VS Build Tools exit: $($p.ExitCode)"
} else { Stage 'VS Build Tools already present' }

# --- Rust, native ARM64 host, plus the x64 cross target ---
# Downloads come from the Mac over the host-only network: the guest's outbound
# HTTPS rides the host's tunnel, which eats these hosts' handshakes the same
# way it ate rustls' (see the TLS note in src-tauri/Cargo.toml). The Mac
# fetches them with its own stack and serves them next to the repo.
if (-not (Test-Path "$env:USERPROFILE\.cargo\bin\cargo.exe")) {
  Stage 'downloading rustup-init (aarch64)'
  Invoke-WebRequest -Uri 'http://192.168.64.1:8765/rustup-init.exe' -OutFile "$dl\rustup-init.exe"
  Stage 'installing rust (via rsproxy.cn mirror)'
  # rustup fetches its toolchain from static.rust-lang.org, which this
  # network's tunnel breaks; rsproxy.cn is the standing mirror that the
  # tunnel is actually built to reach. Same story for crates.io below.
  $env:RUSTUP_DIST_SERVER = 'https://rsproxy.cn'
  $env:RUSTUP_UPDATE_ROOT = 'https://rsproxy.cn/rustup'
  & "$dl\rustup-init.exe" -y --default-host aarch64-pc-windows-msvc --profile minimal 2>&1 | Out-File -Append -Encoding ascii $log
  & "$env:USERPROFILE\.cargo\bin\rustup.exe" target add x86_64-pc-windows-msvc 2>&1 | Out-File -Append -Encoding ascii $log
  [Environment]::SetEnvironmentVariable('RUSTUP_DIST_SERVER','https://rsproxy.cn','Machine')
  [Environment]::SetEnvironmentVariable('RUSTUP_UPDATE_ROOT','https://rsproxy.cn/rustup','Machine')
  New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.cargo" | Out-Null
  @'
[source.crates-io]
replace-with = 'rsproxy-sparse'

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[net]
git-fetch-with-cli = true
'@ | Out-File -Encoding ascii "$env:USERPROFILE\.cargo\config.toml"
  Stage 'rust done'
} else { Stage 'rust already present' }

# --- Node LTS (ARM64) + corepack/pnpm ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stage 'downloading node arm64'
  Invoke-WebRequest -Uri 'http://192.168.64.1:8765/node.msi' -OutFile "$dl\node.msi"
  Stage 'installing node'
  Start-Process msiexec -ArgumentList '/i',"$dl\node.msi",'/qn' -Wait
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  Stage 'enabling corepack/pnpm'
  corepack enable 2>&1 | Out-File -Append -Encoding ascii $log
  # npm's registry is equally unreachable here; npmmirror is the standing CN one.
  [Environment]::SetEnvironmentVariable('NPM_CONFIG_REGISTRY','https://registry.npmmirror.com','Machine')
} else { Stage 'node already present' }

Stage 'fetching repo'
Invoke-WebRequest -Uri 'http://192.168.64.1:8765/repo.zip' -OutFile "$dl\repo.zip"
Expand-Archive -Force "$dl\repo.zip" 'C:\remielle'
Stage 'repo unpacked to C:\remielle'

Stage 'provision COMPLETE'
