# Sets this PC up to print receipts over the USB cable, and prints a slip to
# prove it. Run once per PC, through "Setup printer.cmd" so it gets admin.
#
# Everything here is something a person would otherwise have to type, and two
# of those things are traps nobody guesses:
#
#   * the vendor installer puts its queue on its own "Printer PORT:" monitor,
#     which is attached to nothing - Windows then accepts every receipt,
#     drains the spooler, and the paper stays blank
#   * Windows renumbers the printer to USB003 and up after a replug, leaving
#     the queue aimed at a port with no printer behind it
#
# Both look fine and print nothing, so this fixes them rather than reporting
# them. No vendor driver is needed: receipts are RAW ESC/POS bytes, so
# Windows' own "Generic / Text Only" driver carries them through untouched.

$ErrorActionPreference = 'Stop'

function Say($text) { Write-Host $text }
function Done($text) { Write-Host ""; Write-Host $text; Write-Host ""; Read-Host "Press Enter to close" | Out-Null }

Say ""
Say "POS Printer - USB setup"
Say "======================="
Say ""

# --- 1. is the printer actually plugged in and awake? ----------------------
# A USBPRINT node exists only for a printer that is enumerated right now, and
# its instance id ends in the port Windows put it on. That is the only
# authority on where the cable is.
$livePorts = @(
  Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
    Where-Object { $_.DeviceID -like 'USBPRINT*' } |
    ForEach-Object { if ($_.DeviceID -match '(USB\d+)$') { $Matches[1] } }
) | Select-Object -Unique

if ($livePorts.Count -eq 0) {
  Say "No printer found on USB."
  Say ""
  Say "  * plug the cable straight into this laptop, not through a hub"
  Say "  * switch the printer on - the power light should be steady, not blinking"
  Say "  * close the paper lid until it clicks"
  Say ""
  Say "Then run this again."
  Done "Nothing was changed."
  exit 1
}

$port = $livePorts[0]
Say "Printer is on port $port."

# --- 2. a queue pointing at that port, one way or another ------------------
$queues = @(Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue)
$onPort = @($queues | Where-Object { $_.PortName -eq $port })

if ($onPort.Count -gt 0) {
  $name = $onPort[0].Name
  Say "Already set up: `"$name`" prints to $port."
}
else {
  # A queue for this printer that is wired somewhere else - the vendor's
  # monitor, or a port number from before the last replug. Moving it keeps the
  # printer's own driver, which is better than the generic one if it is there.
  $stray = @(
    $queues | Where-Object {
      $_.Name -match 'pos|58|thermal|receipt' -and $_.PortName -ne $port
    }
  )

  if ($stray.Count -eq 1) {
    $name = $stray[0].Name
    Say "Found `"$name`" on port $($stray[0].PortName), which has no printer behind it."
    Set-Printer -Name $name -PortName $port
    Say "Moved it to $port."
  }
  else {
    # Nothing usable exists, so make one. Generic / Text Only ships with
    # Windows and passes RAW bytes straight through.
    $name = "POS Thermal"
    if (-not (Get-PrinterDriver -Name "Generic / Text Only" -ErrorAction SilentlyContinue)) {
      Say "Adding Windows' Generic / Text Only driver..."
      Add-PrinterDriver -Name "Generic / Text Only"
    }
    if (Get-Printer -Name $name -ErrorAction SilentlyContinue) {
      Set-Printer -Name $name -PortName $port
    }
    else {
      Say "Creating printer `"$name`" on $port..."
      Add-Printer -Name $name -DriverName "Generic / Text Only" -PortName $port
    }
  }
}

# --- 3. prove it, because a queue accepting bytes is not paper -------------
Say ""
Say "Printing a test slip..."

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)]
  static extern bool WritePrinter(IntPtr h, IntPtr bytes, int count, out int written);
  static void Check(bool ok, string what) {
    if (!ok) throw new Exception(what + " failed: Win32 error " + Marshal.GetLastWin32Error());
  }
  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    Check(OpenPrinter(printer, out h, IntPtr.Zero), "OpenPrinter");
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = "Setup test";
      di.pDataType = "RAW";
      Check(StartDocPrinter(h, 1, di), "StartDocPrinter");
      try {
        Check(StartPagePrinter(h), "StartPagePrinter");
        IntPtr buffer = Marshal.AllocCoTaskMem(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, buffer, bytes.Length);
          int written;
          Check(WritePrinter(h, buffer, bytes.Length, out written), "WritePrinter");
        } finally { Marshal.FreeCoTaskMem(buffer); }
      } finally { EndPagePrinter(h); EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@

$slip = New-Object System.Collections.Generic.List[byte]
$slip.AddRange([byte[]]@(0x1B, 0x40))                                  # reset
$slip.AddRange([byte[]]@(0x1B, 0x61, 0x01))                            # centre
$slip.AddRange([System.Text.Encoding]::ASCII.GetBytes("USB SETUP OK`n"))
$slip.AddRange([System.Text.Encoding]::ASCII.GetBytes("$name`n"))
$slip.AddRange([System.Text.Encoding]::ASCII.GetBytes("port $port`n"))
$slip.AddRange([byte[]]@(0x1B, 0x61, 0x00))                            # left
$slip.AddRange([byte[]]@(0x1B, 0x64, 0x04))                            # feed clear of the tear bar

[RawPrinter]::Send($name, $slip.ToArray())

Say ""
Say "Sent. Look at the printer."
Say ""
Say "  Slip came out          -> done. Start the connector and print from the website."
Say "  Paper moved but blank  -> the thermal roll is in upside down. Take it out,"
Say "                            turn it over, put it back. Only one side prints."
Say "  Nothing moved at all   -> the printer is not taking data. Check power, the"
Say "                            paper lid, and try another USB port."
Done "Setup finished."
