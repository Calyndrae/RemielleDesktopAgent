//! macOS window behaviour that Tauri does not expose.
//!
//! ## Why always-on-top is not enough
//!
//! `set_always_on_top` sets the floating window level. That is above ordinary
//! windows, which is why she correctly stays over a dragged Finder window — and
//! it is *below* a fullscreen Space, which is why she disappeared the moment
//! anything went fullscreen and reappeared on swiping back. The menu tick was
//! telling the truth about the setting; the setting simply does not mean what
//! the user reasonably read it to mean.
//!
//! Two separate things have to change, and neither is the same as the other:
//!
//! - **Window level.** Above the level a fullscreen Space occupies, so she is
//!   not covered by it.
//! - **Collection behaviour.** A window belongs to the Space it was created on
//!   unless told otherwise. `CanJoinAllSpaces` makes it follow the user across
//!   Spaces, and `FullScreenAuxiliary` is what permits it to sit over a
//!   fullscreen one at all — without that flag the level alone is ignored.
//!
//! ## Why not simply always use the highest level
//!
//! Because it is rude. At screen-saver level she would also cover the menu bar
//! being pulled down, Mission Control, and the login window. The level used here
//! is high enough to clear a fullscreen Space and no higher, and it is applied
//! only while the user has asked her to stay on top.

use objc2::rc::Retained;
use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior, NSWindowLevel};
use tauri::Runtime;

/// One step above the level a fullscreen Space renders at.
///
/// `NSFloatingWindowLevel` is 3 and loses to fullscreen. `NSStatusWindowLevel`
/// (25) clears it while staying below `NSPopUpMenuWindowLevel` (101) and the
/// screen saver (1000), so menus and Mission Control still come out on top of
/// her — which is the right order for a companion.
const ABOVE_FULLSCREEN: NSWindowLevel = 25;

/// The level a normal floating window sits at, for when the user turns the
/// setting off again.
const FLOATING: NSWindowLevel = 3;

/// Borrows the `NSWindow` behind a Tauri window.
///
/// Returns `None` rather than panicking: `ns_window` fails on a window that has
/// been torn down, and a companion that aborts because a cosmetic setting could
/// not be applied during shutdown would be a poor trade.
fn ns_window<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Option<Retained<NSWindow>> {
    let ptr = window.ns_window().ok()?;
    if ptr.is_null() {
        return None;
    }
    // SAFETY: `ns_window()` hands back the `NSWindow *` tao created for this
    // window, and it stays alive as long as the Tauri window does. `retain`
    // gives us our own reference for the duration of the call.
    unsafe { Retained::retain(ptr.cast::<NSWindow>()) }
}

/// Makes the overlay sit above fullscreen Spaces, or stop doing so.
///
/// Safe to call repeatedly and from any state; it only ever sets values.
pub fn set_above_fullscreen<R: Runtime>(window: &tauri::WebviewWindow<R>, on: bool) {
    let Some(ns) = ns_window(window) else {
        return;
    };

    // Both are plain setters on a live NSWindow. They must run on the main
    // thread, which is where Tauri dispatches command handlers and setup.
    ns.setLevel(if on { ABOVE_FULLSCREEN } else { FLOATING });

    let behaviour = if on {
        // Follow the user between Spaces, and be allowed over a fullscreen one.
        // Without `FullScreenAuxiliary` the level above is ignored and she is
        // covered anyway — the two flags are not alternatives.
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            // Keeps her out of Mission Control's window grid. She is not a
            // document the user is switching between.
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle
    } else {
        NSWindowCollectionBehavior::Default
    };
    ns.setCollectionBehavior(behaviour);
}
