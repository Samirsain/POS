import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const RAW_PRINT_SCRIPT = [
  "param([Parameter(Mandatory=$true)][string]$PrinterName,",
  "      [Parameter(Mandatory=$true)][string]$DataFile)",
  "$ErrorActionPreference = 'Stop'",
  "Add-Type @\"",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class RawPrinter {",
  "  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]",
  "  public class DOCINFO {",
  "    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;",
  "    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;",
  "    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;",
  "  }",
  "  [DllImport(\"winspool.drv\", CharSet=CharSet.Unicode, SetLastError=true)]",
  "  static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);",
  "  [DllImport(\"winspool.drv\", SetLastError=true)] static extern bool ClosePrinter(IntPtr h);",
  "  [DllImport(\"winspool.drv\", CharSet=CharSet.Unicode, SetLastError=true)]",
  "  static extern bool StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);",
  "  [DllImport(\"winspool.drv\", SetLastError=true)] static extern bool EndDocPrinter(IntPtr h);",
  "  [DllImport(\"winspool.drv\", SetLastError=true)] static extern bool StartPagePrinter(IntPtr h);",
  "  [DllImport(\"winspool.drv\", SetLastError=true)] static extern bool EndPagePrinter(IntPtr h);",
  "  [DllImport(\"winspool.drv\", SetLastError=true)]",
  "  static extern bool WritePrinter(IntPtr h, IntPtr bytes, int count, out int written);",
  "  static void Check(bool ok, string what) {",
  "    if (!ok) throw new Exception(what + \" failed: Win32 error \" + Marshal.GetLastWin32Error());",
  "  }",
  "  public static void Send(string printer, byte[] bytes) {",
  "    IntPtr h;",
  "    Check(OpenPrinter(printer, out h, IntPtr.Zero), \"OpenPrinter\");",
  "    try {",
  "      DOCINFO di = new DOCINFO();",
  "      di.pDocName = \"Receipt\";",
  "      di.pDataType = \"RAW\";",
  "      Check(StartDocPrinter(h, 1, di), \"StartDocPrinter\");",
  "      try {",
  "        Check(StartPagePrinter(h), \"StartPagePrinter\");",
  "        IntPtr buffer = Marshal.AllocCoTaskMem(bytes.Length);",
  "        try {",
  "          Marshal.Copy(bytes, 0, buffer, bytes.Length);",
  "          int written;",
  "          Check(WritePrinter(h, buffer, bytes.Length, out written), \"WritePrinter\");",
  "          if (written != bytes.Length)",
  "            throw new Exception(\"short write: \" + written + \" of \" + bytes.Length + \" bytes\");",
  "        } finally { Marshal.FreeCoTaskMem(buffer); }",
  "        EndPagePrinter(h);",
  "      } finally { EndDocPrinter(h); }",
  "    } finally { ClosePrinter(h); }",
  "  }",
  "}",
  "\"@",
  "[RawPrinter]::Send($PrinterName, [System.IO.File]::ReadAllBytes($DataFile))",
  "",
].join("\r\n");

export function printDirectToWindowsPrinter(printerName: string, bytes: Buffer): number {
  const stem = path.join(os.tmpdir(), `pos-receipt-${process.pid}-${Date.now()}`);
  const dataFile = `${stem}.bin`;
  const scriptFile = `${stem}.ps1`;
  fs.writeFileSync(dataFile, bytes);
  fs.writeFileSync(scriptFile, RAW_PRINT_SCRIPT);
  try {
    execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile, printerName, dataFile],
      { encoding: "utf8", timeout: 30000, windowsHide: true },
    );
    return bytes.length;
  } catch (e: any) {
    const detail = String(e?.stderr || e?.stdout || "").trim().split(/\r?\n/)[0];
    throw new Error(detail || e.message);
  } finally {
    fs.rmSync(dataFile, { force: true });
    fs.rmSync(scriptFile, { force: true });
  }
}

