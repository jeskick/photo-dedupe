param(
  [Parameter(Mandatory = $true)][ValidateSet("probe", "pick", "pick-one", "recycle", "reveal")][string]$Action,
  [string]$OutFile = "",
  [string]$ListFile = "",
  [string]$Target = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Write-Result([string]$Text) {
  if (-not $OutFile) { throw "OutFile is required" }
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($OutFile, $Text, $utf8)
}

$pickerSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace PhotoDedupeNative {
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler(IntPtr pbc, IntPtr bhid, IntPtr riid, IntPtr ppv);
    void GetParent(out IntPtr ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IntPtr psi, uint hint, out int piOrder);
  }

  [ComImport, Guid("B63EA76D-1F85-456F-A19C-48159EFA858B")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItemArray {
    void BindToHandler(IntPtr pbc, IntPtr bhid, IntPtr riid, IntPtr ppv);
    void GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
    void GetPropertyDescriptionList(ref Guid key, ref Guid riid, out IntPtr ppv);
    void GetAttributes(int attribFlags, uint sfgaoMask, out uint psfgaoAttribs);
    void GetCount(out uint pdwNumItems);
    void GetItemAt(uint dwIndex, out IShellItem ppsi);
    void EnumItems(out IntPtr ppenumShellItems);
  }

  [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IntPtr psi);
    void SetFolder(IntPtr psi);
    void GetFolder(out IntPtr ppsi);
    void GetCurrentSelection(out IntPtr ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IntPtr ppsi);
    void AddPlace(IntPtr psi, int alignment);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IShellItemArray ppenum);
    void GetSelectedItems(out IntPtr ppsai);
  }

  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  [ClassInterface(ClassInterfaceType.None)]
  public class FileOpenDialogRCW {}

  public static class Picker {
    const uint SigdnFileSysPath = 0x80058000;
    const uint Options = 0x20u | 0x200u | 0x40u | 0x800u | 0x2000000u;

    static string JsonString(string value) {
      StringBuilder sb = new StringBuilder();
      sb.Append('"');
      if (value != null) {
        foreach (char ch in value) {
          if (ch == '\\' || ch == '"') {
            sb.Append('\\');
            sb.Append(ch);
          } else if (ch == '\n') sb.Append("\\n");
          else if (ch == '\r') sb.Append("\\r");
          else sb.Append(ch);
        }
      }
      sb.Append('"');
      return sb.ToString();
    }

    public static string Probe() {
      IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogRCW();
      dialog.SetTitle("probe");
      dialog.SetOptions(Options);
      try {
        IShellItemArray items;
        dialog.GetResults(out items);
        if (items != null) {
          uint count;
          items.GetCount(out count);
        }
      } catch (COMException) {
        return "OK";
      }
      return "OK";
    }

    public static string Pick(string title) {
      IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogRCW();
      dialog.SetOptions(Options);
      dialog.SetTitle(string.IsNullOrEmpty(title) ? "Select folders" : title);
      int hr = dialog.Show(IntPtr.Zero);
      if (hr == unchecked((int)0x800704C7)) return "[]";
      if (hr != 0) Marshal.ThrowExceptionForHR(hr);
      IShellItemArray items;
      dialog.GetResults(out items);
      uint count;
      items.GetCount(out count);
      StringBuilder sb = new StringBuilder();
      sb.Append('[');
      for (uint i = 0; i < count; i++) {
        IShellItem item;
        items.GetItemAt(i, out item);
        IntPtr psz;
        item.GetDisplayName(SigdnFileSysPath, out psz);
        string path = Marshal.PtrToStringUni(psz);
        Marshal.FreeCoTaskMem(psz);
        if (i > 0) sb.Append(',');
        sb.Append(JsonString(path));
      }
      sb.Append(']');
      return sb.ToString();
    }
  }
}
'@

function Get-PickerType {
  if (-not ("PhotoDedupeNative.Picker" -as [type])) {
    Add-Type -TypeDefinition $pickerSource -Language CSharp
  }
}

try {
  if ($Action -eq "probe") {
    Get-PickerType
    $null = [PhotoDedupeNative.Picker]::Probe()
    Add-Type -AssemblyName Microsoft.VisualBasic
    Write-Result "OK"
    exit 0
  }

  if ($Action -eq "pick") {
    Get-PickerType
    $json = [PhotoDedupeNative.Picker]::Pick($env:PICK_TITLE)
    Write-Result $json
    exit 0
  }

  if ($Action -eq "pick-one") {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = [string]$env:PICK_TITLE
    $dialog.ShowNewFolderButton = $false
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    $owner.StartPosition = "CenterScreen"
    $owner.Size = New-Object System.Drawing.Size(0, 0)
    $owner.ShowInTaskbar = $false
    $result = $dialog.ShowDialog($owner)
    $owner.Dispose()
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
      Write-Result ("[" + (ConvertTo-Json -InputObject ([string]$dialog.SelectedPath) -Compress) + "]")
    } else {
      Write-Result "[]"
    }
    exit 0
  }

  if ($Action -eq "reveal") {
    if (-not $Target) { throw "Target is required" }
    if (-not ("PhotoDedupeNative.Revealer" -as [type])) {
      Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace PhotoDedupeNative {
  public static class Revealer {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "ILCreateFromPathW")]
    public static extern IntPtr ILCreateFromPath(string pszPath);
    [DllImport("shell32.dll")]
    public static extern int SHOpenFolderAndSelectItems(IntPtr pidlFolder, uint cidl, IntPtr apidl, uint dwFlags);
    [DllImport("shell32.dll")]
    public static extern void ILFree(IntPtr pidl);
  }
}
"@
    }
    $pidl = [PhotoDedupeNative.Revealer]::ILCreateFromPath($Target)
    if ($pidl -eq [IntPtr]::Zero) { throw "file missing" }
    $hr = [PhotoDedupeNative.Revealer]::SHOpenFolderAndSelectItems($pidl, 0, [IntPtr]::Zero, 0)
    [PhotoDedupeNative.Revealer]::ILFree($pidl)
    if ($hr -lt 0) { throw "reveal failed" }
    Write-Result '{"ok":true}'
    exit 0
  }

  if ($Action -eq "recycle") {
    if (-not $ListFile) { throw "ListFile is required" }
    Add-Type -AssemblyName Microsoft.VisualBasic
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $paths = [System.IO.File]::ReadAllLines($ListFile, $utf8)
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($raw in $paths) {
      $target = [string]$raw
      if ([string]::IsNullOrWhiteSpace($target)) { continue }
      try {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
          $target,
          [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
          [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
        )
        $parts.Add(('{"ok":true,"path":' + (ConvertTo-Json -InputObject $target -Compress) + "}"))
      } catch {
        $message = $_.Exception.Message
        $parts.Add(('{"ok":false,"path":' + (ConvertTo-Json -InputObject $target -Compress) + ',"error":' + (ConvertTo-Json -InputObject $message -Compress) + "}"))
      }
    }
    Write-Result ("[" + ($parts -join ",") + "]")
    exit 0
  }
} catch {
  $message = $_.Exception.Message
  if ($OutFile) {
    try { Write-Result $message } catch {}
  }
  [Console]::Error.WriteLine($message)
  exit 1
}
