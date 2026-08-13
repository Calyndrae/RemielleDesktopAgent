//! Exercises the tool executors against the real OS, outside the app.
//!
//! `cargo test` proves the parsers and the catalog agree; it cannot prove that
//! `SendInput` reaches the session or that a snapped window actually lands on
//! the half of the screen the maths intended. This binary exists for that gap:
//! run it in an interactive session, watch the window move, read the printed
//! outcomes. It drives exactly the public entry points the dispatch loop uses,
//! so what it verifies is what she would do.
//!
//!     cargo run --release --example tooltest -- arrange
//!     cargo run --release --example tooltest -- media
//!
//! `arrange` walks the foreground window through snap_left → snap_right →
//! maximize → minimize with a pause between each, so a human (or a screenshot)
//! can confirm every position. `media` taps volume_up then volume_down — a
//! zero-net-change pair — and play_pause twice, which together leave the
//! machine as it was found.

use remielle_lib::tools::{media, window};

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "arrange".into());
    let pause = std::time::Duration::from_millis(1200);

    match mode.as_str() {
        "arrange" => {
            for action in ["snap_left", "snap_right", "maximize", "minimize"] {
                std::thread::sleep(pause);
                match window::arrange_window(action) {
                    Ok(outcome) => println!("OK   {action}: {}", outcome.result),
                    Err(error) => println!("FAIL {action}: {error}"),
                }
            }
        }
        "media" => {
            for action in ["volume_up", "volume_down", "play_pause", "play_pause"] {
                std::thread::sleep(pause);
                match media::media_control(action) {
                    Ok(outcome) => println!("OK   {action}: {}", outcome.result),
                    Err(error) => println!("FAIL {action}: {error}"),
                }
            }
        }
        other => {
            eprintln!("unknown mode {other:?}; use 'arrange' or 'media'");
            std::process::exit(2);
        }
    }
}
