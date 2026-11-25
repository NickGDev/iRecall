fn main() {
    // Expose the Rust target triple to the code: the bundled node sidecar is
    // named node-<triple> (see spawn_server).
    println!("cargo:rustc-env=TARGET={}", std::env::var("TARGET").unwrap());
    tauri_build::build()
}
