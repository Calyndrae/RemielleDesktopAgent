pub mod overlay;
pub mod passthrough;
pub mod shortcut;
pub mod tray;

/// Label of the transparent always-on-top window that hosts the sprite, the
/// chat panel, toasts and the narration box.
///
/// Everything the user sees on the desktop lives in this single window on
/// purpose: the chat panel has to blur, squash and fly along an arc *behind*
/// the character when it closes, and z-ordering across separate OS windows
/// cannot do that. One window means one DOM, one transform space, one
/// `z-index`.
pub const OVERLAY_LABEL: &str = "overlay";
