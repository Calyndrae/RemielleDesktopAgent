# Windows build VM

A local UTM VM (`Windows` — Windows 11 25H2 ARM64, native virtualization on
Apple Silicon) exists to produce the Windows bundle this repo cannot build on
macOS. It was installed unattended; the answer file and guest-tools notes live
with the session records.

## Provisioning (`provision.ps1`)

Installs the full toolchain — VS Build Tools (MSVC ARM64 + x64 cross), Rust
(aarch64 host + x86_64 target), Node LTS, pnpm — then fetches the repo. It
logs every stage to `C:\provision.log`.

The repo reaches the guest over HTTP from the Mac: from the repo root,
`git archive --format=zip -o repo.zip HEAD`, serve the directory with
`python3 -m http.server 8765`, and `provision.ps1` pulls
`http://192.168.64.1:8765/repo.zip` (the UTM shared-network host address).

## Driving the guest headlessly

UTM's `execute` (AppleScript, or `utmctl`) runs commands in the guest **only
while the QEMU guest agent is running** — which requires UTM's guest support
tools installed as a persistent service. On a fresh install the agent answers
once but does NOT survive a reboot until those tools are installed through the
VM's GUI. Install them once; after that every reboot keeps the agent, and
provisioning/builds run with no screen and no clicks.
