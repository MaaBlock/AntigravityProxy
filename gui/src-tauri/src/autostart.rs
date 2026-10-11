pub fn set_autostart(enable: bool, start_minimized: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let path = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        let (key, _) = hkcu.create_subkey(path).map_err(|e| e.to_string())?;

        let app_name = "AntigravityProxy";
        if enable {
            let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let exe_str = current_exe.to_string_lossy();
            let val = if start_minimized {
                format!("\"{}\" --minimized", exe_str)
            } else {
                format!("\"{}\"", exe_str)
            };
            key.set_value(app_name, &val).map_err(|e| e.to_string())?;
        } else {
            let _ = key.delete_value(app_name);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (enable, start_minimized);
        Ok(())
    }
}

pub fn is_autostart_enabled() -> bool {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let path = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        if let Ok(key) = hkcu.open_subkey(path) {
            let app_name = "AntigravityProxy";
            let val: Result<String, _> = key.get_value(app_name);
            return val.is_ok();
        }
        false
    }
    #[cfg(not(windows))]
    {
        false
    }
}
