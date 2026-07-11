//! On Windows, console children of a GUI app (grok, claude, git, gh, cmd)
//! each pop their own console window unless spawned with CREATE_NO_WINDOW.
//! `.quiet()` keeps every subprocess invisible; output capture is unaffected
//! because everything already reads via pipes, and Job Object containment is
//! orthogonal to the console flag. No-op on other platforms.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub trait Quiet {
    fn quiet(&mut self) -> &mut Self;
}

impl Quiet for std::process::Command {
    fn quiet(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl Quiet for tokio::process::Command {
    fn quiet(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}
