//! Asset packs: the sprite's animations, described by data rather than
//! hardcoded paths.
//!
//! A pack is a directory containing `pack.json` plus the animation files. This
//! indirection buys three things at once: the `/emote change <name>` candidate
//! list is just the pack's animation list, per-animation registration offsets
//! travel with the art, and swapping in a different character later needs no
//! code change.
//!
//! Packs are looked up in two places, user packs first so a bundled pack can be
//! overridden without touching the install:
//!   1. `<app data>/packs/<id>/pack.json`
//!   2. `<resources>/packs/<id>/pack.json`

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, thiserror::Error)]
pub enum AssetError {
    #[error("no asset pack directory found for '{0}'")]
    PackNotFound(String),
    #[error("could not read {path}: {source}")]
    Read {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{path} is not valid pack JSON: {source}")]
    Parse {
        path: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("pack '{pack}' declares animation '{animation}' but {file} is missing")]
    MissingAnimationFile {
        pack: String,
        animation: String,
        file: String,
    },
    #[error("pack '{pack}' maps state '{state}' to unknown animation '{animation}'")]
    UnknownStateAnimation {
        pack: String,
        state: String,
        animation: String,
    },
    #[error("pack '{pack}' is missing a mapping for required state '{state}'")]
    MissingRequiredState { pack: String, state: String },
}

impl serde::Serialize for AssetError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// States the app drives the sprite through. A pack must map all of these; the
/// app would otherwise have nothing to show at a moment the user is watching.
const REQUIRED_STATES: &[&str] = &["idle", "thinking", "writing"];

/// Pixel offset applied when an animation is drawn, correcting for animations
/// whose canvases aren't aligned to the same registration point.
///
/// Without this the character visibly jumps when switching between, say, idle
/// and thinking. Ported from Little-Remielle's `坐标配置.json`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Offset {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Animation {
    /// Stable identifier used by `/emote change <id>` and by the state map.
    pub id: String,
    /// Display names per locale, e.g. `{"zh-CN": "待机", "en": "Idle"}`.
    #[serde(default)]
    pub label: HashMap<String, String>,
    /// File name relative to the pack directory.
    pub file: String,
    #[serde(default)]
    pub offset: Offset,
    /// The animation's own pixel dimensions, read from the file at load time.
    ///
    /// Not declared in the manifest, because a hand-written number can be wrong
    /// and this one cannot: it comes from the image itself. It matters because
    /// the frames in a pack are *not* all the same size — Little-Remielle's run
    /// from 257x278 to 302x298 — and the offsets beside them are raw-pixel
    /// translations of a frame drawn at its natural size. Scaling each frame to
    /// fit a shared box would give every animation a different scale factor and
    /// reintroduce exactly the jump the offsets exist to remove.
    #[serde(default, skip_deserializing)]
    pub size: FrameSize,
    /// Absolute path on disk, resolved at load time. The frontend runs this
    /// through `convertFileSrc` to get an `asset:` URL it can put in an `<img>`.
    #[serde(default, skip_deserializing)]
    pub path: String,
    /// Whether this animation should be offered by `/emote change`. Set false
    /// for purely internal states.
    #[serde(default = "default_true")]
    pub selectable: bool,
}

fn default_true() -> bool {
    true
}

/// Reads an image's pixel dimensions without decoding it.
///
/// GIF puts them in the logical screen descriptor, four little-endian bytes at
/// offset 6, so this is a ten-byte read rather than a decode and an image
/// dependency. Anything that is not a GIF, or is truncated, returns `None` and
/// falls back to the pack's shared frame size.
fn read_gif_size(path: &Path) -> Option<FrameSize> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut header = [0u8; 10];
    std::io::Read::read_exact(&mut file, &mut header).ok()?;
    if &header[..3] != b"GIF" {
        return None;
    }
    let width = u16::from_le_bytes([header[6], header[7]]);
    let height = u16::from_le_bytes([header[8], header[9]]);
    if width == 0 || height == 0 {
        return None;
    }
    Some(FrameSize {
        width: f64::from(width),
        height: f64::from(height),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackManifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub license: String,
    /// Attribution lines. Surfaced in the About page — CC BY requires credit to
    /// be visible to the end user, not just present in the repository.
    #[serde(default)]
    pub credits: Vec<String>,
    pub frame_size: FrameSize,
    pub animations: Vec<Animation>,
    /// Maps an agent state (`idle`, `thinking`, `writing`, ...) to an animation id.
    pub states: HashMap<String, String>,
}

impl PackManifest {
    fn animation(&self, id: &str) -> Option<&Animation> {
        self.animations.iter().find(|a| a.id == id)
    }

    /// Checks that every declared file exists and every state maps to a real
    /// animation. Runs at load time so a broken pack fails loudly and
    /// specifically instead of rendering an invisible character.
    fn validate(&self, dir: &Path) -> Result<(), AssetError> {
        for animation in &self.animations {
            if !dir.join(&animation.file).is_file() {
                return Err(AssetError::MissingAnimationFile {
                    pack: self.id.clone(),
                    animation: animation.id.clone(),
                    file: animation.file.clone(),
                });
            }
        }

        for (state, animation_id) in &self.states {
            if self.animation(animation_id).is_none() {
                return Err(AssetError::UnknownStateAnimation {
                    pack: self.id.clone(),
                    state: state.clone(),
                    animation: animation_id.clone(),
                });
            }
        }

        for required in REQUIRED_STATES {
            if !self.states.contains_key(*required) {
                return Err(AssetError::MissingRequiredState {
                    pack: self.id.clone(),
                    state: (*required).to_string(),
                });
            }
        }

        Ok(())
    }
}

/// Directories searched for packs, highest priority first.
fn pack_roots<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = app.path().app_data_dir() {
        roots.push(dir.join("packs"));
    }
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir.join("packs"));
    }
    roots
}

fn read_manifest(dir: &Path) -> Result<PackManifest, AssetError> {
    let manifest_path = dir.join("pack.json");
    let raw = std::fs::read_to_string(&manifest_path).map_err(|source| AssetError::Read {
        path: manifest_path.display().to_string(),
        source,
    })?;

    let mut manifest: PackManifest =
        serde_json::from_str(&raw).map_err(|source| AssetError::Parse {
            path: manifest_path.display().to_string(),
            source,
        })?;

    manifest.validate(dir)?;

    for animation in &mut manifest.animations {
        let file = dir.join(&animation.file);
        // Its own dimensions if the file will tell us, otherwise the pack's
        // shared frame size — a pack whose frames really are uniform then needs
        // to say nothing at all.
        animation.size = read_gif_size(&file).unwrap_or(manifest.frame_size);
        animation.path = file.display().to_string();
    }

    Ok(manifest)
}

/// Loads a pack by id, preferring a user-installed copy over the bundled one.
#[tauri::command]
pub fn load_pack<R: Runtime>(app: AppHandle<R>, id: String) -> Result<PackManifest, AssetError> {
    for root in pack_roots(&app) {
        let dir = root.join(&id);
        if dir.join("pack.json").is_file() {
            return read_manifest(&dir);
        }
    }
    Err(AssetError::PackNotFound(id))
}

/// Lists every pack that loads cleanly, for the pack picker in settings.
///
/// Packs that fail validation are skipped rather than failing the whole call —
/// one malformed third-party pack shouldn't make the picker unusable.
#[tauri::command]
pub fn list_packs<R: Runtime>(app: AppHandle<R>) -> Vec<PackManifest> {
    let mut found: Vec<PackManifest> = Vec::new();

    for root in pack_roots(&app) {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            match read_manifest(&entry.path()) {
                Ok(manifest) => {
                    // First root wins: a user pack shadows a bundled one.
                    if !found.iter().any(|p| p.id == manifest.id) {
                        found.push(manifest);
                    }
                }
                Err(err) => log::warn!("skipping pack at {:?}: {err}", entry.path()),
            }
        }
    }

    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_json(states: &str) -> String {
        format!(
            r#"{{
              "id": "test-pack",
              "name": "Test Pack",
              "license": "CC BY-NC-SA 4.0",
              "credits": ["someone"],
              "frameSize": {{ "width": 300, "height": 300 }},
              "animations": [
                {{ "id": "idle", "file": "idle.gif", "offset": {{ "x": 0, "y": -4 }} }},
                {{ "id": "thinking", "file": "thinking.gif" }},
                {{ "id": "writing", "file": "writing.gif" }}
              ],
              "states": {states}
            }}"#
        )
    }

    fn write_pack(dir: &Path, json: &str, files: &[&str]) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("pack.json"), json).unwrap();
        for file in files {
            std::fs::write(dir.join(file), b"gif").unwrap();
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("remielle-assets-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    const ALL_STATES: &str = r#"{ "idle": "idle", "thinking": "thinking", "writing": "writing" }"#;

    #[test]
    fn loads_valid_pack_and_resolves_paths() {
        let dir = temp_dir("valid");
        write_pack(
            &dir,
            &manifest_json(ALL_STATES),
            &["idle.gif", "thinking.gif", "writing.gif"],
        );

        let manifest = read_manifest(&dir).unwrap();
        assert_eq!(manifest.id, "test-pack");
        assert_eq!(manifest.animations.len(), 3);

        let idle = manifest.animation("idle").unwrap();
        assert_eq!(idle.offset.y, -4.0);
        assert!(idle.path.ends_with("idle.gif"));
        // Paths must be absolute for convertFileSrc to work.
        assert!(Path::new(&idle.path).is_absolute());
        // `selectable` defaults to true so packs don't have to spell it out.
        assert!(idle.selectable);
    }

    #[test]
    fn rejects_pack_with_missing_file() {
        let dir = temp_dir("missing-file");
        // thinking.gif is declared but never written.
        write_pack(
            &dir,
            &manifest_json(ALL_STATES),
            &["idle.gif", "writing.gif"],
        );

        let err = read_manifest(&dir).unwrap_err();
        assert!(
            matches!(err, AssetError::MissingAnimationFile { ref animation, .. } if animation == "thinking"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn rejects_state_pointing_at_unknown_animation() {
        let dir = temp_dir("bad-state");
        let states = r#"{ "idle": "idle", "thinking": "nope", "writing": "writing" }"#;
        write_pack(
            &dir,
            &manifest_json(states),
            &["idle.gif", "thinking.gif", "writing.gif"],
        );

        let err = read_manifest(&dir).unwrap_err();
        assert!(
            matches!(err, AssetError::UnknownStateAnimation { ref animation, .. } if animation == "nope"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn rejects_pack_missing_a_required_state() {
        let dir = temp_dir("missing-state");
        let states = r#"{ "idle": "idle", "thinking": "thinking" }"#;
        write_pack(
            &dir,
            &manifest_json(states),
            &["idle.gif", "thinking.gif", "writing.gif"],
        );

        let err = read_manifest(&dir).unwrap_err();
        assert!(
            matches!(err, AssetError::MissingRequiredState { ref state, .. } if state == "writing"),
            "unexpected error: {err}"
        );
    }
}

#[cfg(test)]
mod gif_size_tests {
    use super::*;
    use std::io::Write;

    fn write_gif(dir: &Path, name: &str, width: u16, height: u16) -> PathBuf {
        let path = dir.join(name);
        let mut file = std::fs::File::create(&path).expect("create");
        file.write_all(b"GIF89a").expect("magic");
        file.write_all(&width.to_le_bytes()).expect("width");
        file.write_all(&height.to_le_bytes()).expect("height");
        // Enough trailing bytes that this looks like a real header.
        file.write_all(&[0xF7, 0x00, 0x00]).expect("descriptor");
        path
    }

    #[test]
    fn reads_dimensions_from_the_logical_screen_descriptor() {
        let dir = std::env::temp_dir().join("remielle-gif-size");
        std::fs::create_dir_all(&dir).expect("dir");

        // The real spread in the shipped pack: 257x278 up to 302x298.
        let small = write_gif(&dir, "small.gif", 257, 278);
        let large = write_gif(&dir, "large.gif", 302, 298);

        let a = read_gif_size(&small).expect("small");
        assert_eq!((a.width, a.height), (257.0, 278.0));
        let b = read_gif_size(&large).expect("large");
        assert_eq!((b.width, b.height), (302.0, 298.0));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn declines_anything_that_is_not_a_readable_gif() {
        let dir = std::env::temp_dir().join("remielle-gif-size-bad");
        std::fs::create_dir_all(&dir).expect("dir");

        // Not a GIF, truncated, and a zero-sized one — each has to fall back to
        // the pack's shared frame size rather than produce a zero-width sprite.
        let png = dir.join("not.png");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\n0123456789").expect("write");
        assert!(read_gif_size(&png).is_none());

        let short = dir.join("short.gif");
        std::fs::write(&short, b"GIF89").expect("write");
        assert!(read_gif_size(&short).is_none());

        assert!(read_gif_size(&write_gif(&dir, "zero.gif", 0, 0)).is_none());
        assert!(read_gif_size(&dir.join("absent.gif")).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod shipped_pack_tests {
    use super::*;

    /// The pack that actually ships, read from the repository.
    fn shipped() -> Option<PackManifest> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()?
            .join("assets/packs/little-remielle");
        // Absent in a source checkout that has not fetched the assets; the rest
        // of the suite must still run there.
        dir.join("pack.json").exists().then_some(())?;
        read_manifest(&dir).ok()
    }

    #[test]
    fn every_animation_the_manifest_names_is_actually_present() {
        let Some(pack) = shipped() else { return };
        for animation in &pack.animations {
            assert!(
                Path::new(&animation.path).exists(),
                "'{}' names {} which is not in the pack",
                animation.id,
                animation.file
            );
        }
    }

    #[test]
    fn frames_are_measured_from_the_files_rather_than_assumed() {
        let Some(pack) = shipped() else { return };
        for animation in &pack.animations {
            assert!(
                animation.size.width > 0.0 && animation.size.height > 0.0,
                "'{}' has no measured size",
                animation.id
            );
        }

        // The point of measuring: they genuinely differ. If this ever becomes
        // false the whole natural-size path could be simplified away.
        let widths: Vec<f64> = pack.animations.iter().map(|a| a.size.width).collect();
        assert!(
            widths.windows(2).any(|w| w[0] != w[1]),
            "all frames are the same width — the per-frame sizing is now dead weight",
        );
    }

    #[test]
    fn the_shared_box_encloses_every_frame() {
        // Frames are drawn at natural size inside this box. One larger than the
        // box would be clipped at the edges.
        let Some(pack) = shipped() else { return };
        for animation in &pack.animations {
            assert!(
                animation.size.width <= pack.frame_size.width
                    && animation.size.height <= pack.frame_size.height,
                "'{}' is {}x{}, larger than the pack's {}x{} box",
                animation.id,
                animation.size.width,
                animation.size.height,
                pack.frame_size.width,
                pack.frame_size.height,
            );
        }
    }

    #[test]
    fn the_registration_offsets_came_across_intact() {
        // Transcribed from the upstream 坐标配置.json. Without them she jumps
        // when the state changes, which is the one thing they exist to prevent.
        let Some(pack) = shipped() else { return };
        let by_file = |file: &str| {
            pack.animations
                .iter()
                .find(|a| a.file == file)
                .map(|a| (a.offset.x, a.offset.y))
        };

        assert_eq!(by_file("待机.gif"), Some((0.0, 0.0)));
        assert_eq!(by_file("拿笔待机.gif"), Some((0.0, -5.0)));
        assert_eq!(by_file("思考.gif"), Some((0.0, -3.0)));
        assert_eq!(by_file("连续绘制.gif"), Some((-39.0, 4.0)));
        assert_eq!(by_file("间歇绘制.gif"), Some((-45.0, -10.0)));
        assert_eq!(by_file("期待.gif"), Some((0.0, -5.0)));
        assert_eq!(by_file("得意.gif"), Some((15.0, 0.0)));
    }

    #[test]
    fn every_agent_state_resolves_to_a_real_animation() {
        let Some(pack) = shipped() else { return };
        for (state, id) in &pack.states {
            assert!(
                pack.animation(id).is_some(),
                "state '{state}' maps to '{id}', which the pack does not contain",
            );
        }
    }

    #[test]
    fn the_pack_credits_everyone_it_has_to() {
        // CC BY-NC-SA: attribution has to reach the end user, and the About page
        // renders exactly this list.
        let Some(pack) = shipped() else { return };
        let credits = pack.credits.join(" ");
        assert!(credits.contains("HoYoverse"), "missing the rights holder");
        assert!(credits.contains("森哈_Yeah"), "missing the animator");
        assert!(credits.contains("ZanyZebra1127"), "missing the pack author");
        assert!(pack.license.contains("CC BY-NC-SA"), "licence not stated");
    }
}
