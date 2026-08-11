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
if (-not (Test-Path "$env:USERPROFILE\.cargo\bin\cargo.exe")) {
  Stage 'downloading rustup-init (aarch64)'
  Invoke-WebRequest -Uri 'https://static.rust-lang.org/rustup/dist/aarch64-pc-windows-msvc/rustup-init.exe' -OutFile "$dl\rustup-init.exe"
  Stage 'installing rust'
  & "$dl\rustup-init.exe" -y --default-host aarch64-pc-windows-msvc --profile minimal | Out-File -Append -Encoding ascii $log
  & "$env:USERPROFILE\.cargo\bin\rustup.exe" target add x86_64-pc-windows-msvc | Out-File -Append -Encoding ascii $log
  Stage 'rust done'
} else { Stage 'rust already present' }

# --- Node LTS (ARM64) + corepack/pnpm ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stage 'downloading node arm64'
  Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-arm64.msi' -OutFile "$dl\node.msi"
  Stage 'installing node'
  Start-Process msiexec -ArgumentList '/i',"$dl\node.msi",'/qn' -Wait
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  Stage 'enabling corepack/pnpm'
  corepack enable 2>&1 | Out-File -Append -Encoding ascii $log
} else { Stage 'node already present' }

Stage 'fetching repo'
Invoke-WebRequest -Uri 'http://192.168.64.1:8765/repo.zip' -OutFile "$dl\repo.zip"
Expand-Archive -Force "$dl\repo.zip" 'C:\remielle'
Stage 'repo unpacked to C:\remielle'

Stage 'provision COMPLETE'
