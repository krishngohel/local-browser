# Registers Echo in the current user's Start Menu the same way the NSIS installer does.
$ErrorActionPreference = "Stop"

function Set-ShortcutAppUserModelId {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$AppId
  )

  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class EchoShortcutAppId {
  [ComImport]
  [Guid("00021401-0000-0000-C000-000000000046")]
  private class ShellLink {
  }

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("000214F9-0000-0000-C000-000000000046")]
  private interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszFile, int cchMaxPath, IntPtr pfd, int fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszName, int cchMaxName);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszDir, int cchMaxPath);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszArgs, int cchMaxPath);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszIconPath, int cchIconPath, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
    void Resolve(IntPtr hwnd, int fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
  }

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  private interface IPropertyStore {
    uint GetCount(out uint cProps);
    uint GetAt(uint iProp, out PROPERTYKEY pkey);
    uint GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    uint SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    uint Commit();
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  private struct PROPERTYKEY {
    public Guid fmtid;
    public uint pid;
  }

  [StructLayout(LayoutKind.Explicit)]
  private struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pszVal;
  }

  public static void Apply(string lnk, string appId) {
    object raw = new ShellLink();
    IPersistFile persist = (IPersistFile)raw;
    persist.Load(lnk, 2);
    IPropertyStore store = (IPropertyStore)raw;
    PROPERTYKEY key = new PROPERTYKEY();
    key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    key.pid = 5;
    PROPVARIANT value = new PROPVARIANT();
    value.vt = 31;
    value.pszVal = Marshal.StringToCoTaskMemUni(appId);
    store.SetValue(ref key, ref value);
    store.Commit();
    persist.Save(lnk, true);
    Marshal.FreeCoTaskMem(value.pszVal);
  }
}
"@

  [EchoShortcutAppId]::Apply($Path, $AppId)
}

function Notify-StartMenu {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class EchoShellNotify {
  [DllImport("shell32.dll")]
  public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
"@
  [EchoShellNotify]::SHChangeNotify(0x8000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)
}

$repo = Split-Path -Parent $PSScriptRoot
$candidates = @(
  (Join-Path $env:LOCALAPPDATA "Programs\Echo\Echo.exe"),
  (Join-Path $repo "dist-installer\win-unpacked\Echo.exe")
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
  Write-Error "Echo.exe not found. Run npm run dist first, then npm run start-menu."
}

$programs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
New-Item -ItemType Directory -Force -Path $programs | Out-Null
$lnk = Join-Path $programs "Echo.lnk"

$wshell = New-Object -ComObject WScript.Shell
$shortcut = $wshell.CreateShortcut($lnk)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = Split-Path $exe
$shortcut.IconLocation = "$exe,0"
$shortcut.Description = "Echo"
$shortcut.WindowStyle = 1
$shortcut.Save()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($wshell) | Out-Null
Start-Sleep -Milliseconds 200

try {
  Set-ShortcutAppUserModelId -Path $lnk -AppId "com.echo.browser"
} catch {
  Write-Warning "Shortcut created, but Windows blocked setting the app id: $($_.Exception.Message)"
}
Notify-StartMenu

Write-Host "Start Menu shortcut: $lnk"
Write-Host "Target: $exe"
Write-Host "Search for Echo in the Start menu."
