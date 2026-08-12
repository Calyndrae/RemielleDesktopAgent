# Pushing v0.1.0 to GitHub

Everything is committed and tagged locally; these are the steps that need your
credentials. Nothing here has been run for you.

## 1. Authenticate (once)

```bash
brew install gh && gh auth login
```

## 2. Create the repo and push

This repo has **no remote** and shares no history with any existing GitHub copy.
Pushing it will publish the full history of this local tree.

```bash
cd ~/GIT/RemielleDesktopAgent
gh repo create RemielleDesktopAgent --public --source=. --remote=origin
git push -u origin HEAD
git push origin v0.1.0
```

If you would rather push into the **existing** `Calyndrae/RemielleDesktopAgent`,
note the histories are unrelated — you would need `--force` (destroys what is
there) or a merge with `--allow-unrelated-histories`. Decide deliberately.

## 3. Create the release with both platforms attached

```bash
cd ~/GIT/RemielleDesktopAgent
gh release create v0.1.0 \
  release/*.dmg release/*.exe \
  --title "Remielle Desktop Agent v0.1.0" \
  --notes-file release/RELEASE_NOTES.md
```

## 4. Windows code signing (removes "unknown publisher")

A CA-issued certificate is required; self-signed does not clear SmartScreen.
The free route for open-source projects:

1. Repo must be **public** on GitHub (step 2).
2. Apply to SignPath Foundation: <https://signpath.org/apply>
   (free certificates for OSS; they review the project).
3. Once approved, add SignPath's GitHub Action to `.github/workflows/build.yml`
   so release binaries are signed automatically on tag.

Until then the SmartScreen warning is expected — the release notes tell users
how to proceed.
