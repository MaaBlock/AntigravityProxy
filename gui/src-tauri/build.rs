fn main() {
    // Tauri's default build script does not reliably invalidate the embedded
    // asset bundle when only a plain JS/CSS file changes. Track the whole
    // renderer tree so release builds cannot silently ship stale frontend code.
    println!("cargo:rerun-if-changed=../src/renderer");
    tauri_build::build()
}
