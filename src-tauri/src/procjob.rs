//! Crash-safe child-process containment.
//!
//! Every harness session is a child process (grok/claude). If the app exits
//! normally we cancel them, but a hard crash would orphan them — and an
//! orphaned agent session keeps burning subscription quota. On Windows we put
//! the whole app in a Job Object with KILL_ON_JOB_CLOSE: when the app process
//! dies for ANY reason (clean exit, panic, taskkill, power loss of the parent),
//! the OS tears down every process assigned to the job. Sessions cannot outlive
//! the app.

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    struct Job(HANDLE);
    // The HANDLE is only ever used from behind this global and is process-wide.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Job> = OnceLock::new();

    pub fn init() {
        unsafe {
            let Ok(job) = CreateJobObjectW(None, PCWSTR::null()) else { return };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let _ = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let _ = JOB.set(Job(job));
        }
    }

    pub fn contain(pid: u32) {
        unsafe {
            let Some(job) = JOB.get() else { return };
            let Ok(handle) = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) else { return };
            let _ = AssignProcessToJobObject(job.0, handle);
            let _ = CloseHandle(handle);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn init() {}
    pub fn contain(_pid: u32) {}
}

/// Create the kill-on-close job. Call once at startup, before any session.
pub fn init() {
    imp::init();
}

/// Put a spawned session into the job so it dies with the app.
pub fn contain(pid: u32) {
    imp::contain(pid);
}
