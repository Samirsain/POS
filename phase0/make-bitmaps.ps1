<#
  Renders every phase0/assets/*.txt into a 1-bit ESC/POS raster command, ONCE,
  at build time. Spec §8.1: bitmaps are build assets, never runtime conversions.

  Devanagari cannot be sent to this printer as text at all — no Unicode, no
  Devanagari code page (§1.1) — so every Hindi heading has to arrive as dots.

  Source files are named  <asset-id>@<widthDots>.txt  and hold the text in UTF-8.
  The width is the LARGE size; it must be a multiple of 8 and at most 384 (the
  print head). Each source produces three assets - <id>-s, <id>-m, <id>-l - at
  50%, 75% and 100% of that width, because a raster cannot be resized at print
  time. Picking a smaller one is also how you cut Bluetooth latency: bytes scale
  with the square of the width.

  Knobs, because the physical result needs tuning a preview cannot show:
    -Threshold  0..255 grey cut-off. Prints too heavy? Raise it.
    -Ink        0..1, how much of the width the glyphs fill.
    -FontName   any installed font that covers the script.
#>
param(
  [int]$Threshold = 160,
  [double]$Ink = 0.92,
  [string]$FontName = 'Nirmala UI',
  [string]$AssetDir = "$PSScriptRoot\assets"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$PAPER_DOTS = 384

function Convert-TextToRaster {
  param([string]$Text, [int]$Width, [string]$OutBin, [string]$OutPng)

  if ($Width % 8 -ne 0) { throw "width must be a multiple of 8 (got $Width)" }
  if ($Width -gt $PAPER_DOTS) { throw "width $Width exceeds the $PAPER_DOTS dot print head" }

  $SS = 4                          # supersample, then threshold down to 1-bit
  $bigW = $Width * $SS
  $bigH = $bigW                    # generous canvas; cropped to the ink below

  # Size the font so the text fills the target width.
  $probe = New-Object System.Drawing.Bitmap 1, 1
  $pg = [System.Drawing.Graphics]::FromImage($probe)
  $typo = [System.Drawing.StringFormat]::GenericTypographic
  $f0 = New-Object System.Drawing.Font($FontName, 100.0, [System.Drawing.GraphicsUnit]::Pixel)
  $m = $pg.MeasureString($Text, $f0, [int]::MaxValue, $typo)
  if ($m.Width -le 0) { throw "font '$FontName' rendered nothing for '$Text'" }
  $size = 100.0 * [Math]::Min($bigW / $m.Width, $bigH / $m.Height) * 0.9
  $f0.Dispose(); $pg.Dispose(); $probe.Dispose()

  $font = New-Object System.Drawing.Font($FontName, $size, [System.Drawing.GraphicsUnit]::Pixel)
  $canvas = New-Object System.Drawing.Bitmap $bigW, $bigH
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.Clear([System.Drawing.Color]::White)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $center = New-Object System.Drawing.StringFormat
  $center.Alignment = 'Center'; $center.LineAlignment = 'Center'
  # DrawString shapes Devanagari conjuncts (श्री) correctly via Uniscribe.
  $g.DrawString($Text, $font, [System.Drawing.Brushes]::Black,
                (New-Object System.Drawing.RectangleF 0, 0, $bigW, $bigH), $center)
  $g.Dispose(); $font.Dispose()

  # Crop to the ink so the glyphs actually fill the requested width.
  $rect = New-Object System.Drawing.Rectangle 0, 0, $bigW, $bigH
  $data = $canvas.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                           [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $buf = New-Object byte[] ($data.Stride * $bigH)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $buf.Length)
  $canvas.UnlockBits($data)

  $minX = $bigW; $minY = $bigH; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $bigH; $y++) {
    $row = $y * $data.Stride
    for ($x = 0; $x -lt $bigW; $x++) {
      if ($buf[$row + $x * 4] -lt $Threshold) {
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  if ($maxX -lt 0) { throw "no ink — does '$FontName' cover the characters in '$Text'?" }

  $cw = $maxX - $minX + 1
  $ch = $maxY - $minY + 1
  # Fit by width; height follows the aspect ratio so nothing is squashed.
  $scale = ($Width * $Ink) / $cw
  $dw = [int][Math]::Round($cw * $scale)
  $dh = [int][Math]::Round($ch * $scale)
  $Height = [int][Math]::Ceiling($dh / 8.0) * 8

  $final = New-Object System.Drawing.Bitmap $Width, $Height
  $fg = [System.Drawing.Graphics]::FromImage($final)
  $fg.Clear([System.Drawing.Color]::White)
  $fg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $fg.DrawImage($canvas,
    (New-Object System.Drawing.Rectangle ([int](($Width - $dw) / 2)), ([int](($Height - $dh) / 2)), $dw, $dh),
    (New-Object System.Drawing.Rectangle $minX, $minY, $cw, $ch),
    [System.Drawing.GraphicsUnit]::Pixel)
  $fg.Dispose(); $canvas.Dispose()

  # Pack to 1-bit, MSB first, 1 = black.
  $bytesPerRow = $Width / 8
  $on = 0
  $raster = New-Object byte[] ($bytesPerRow * $Height)
  for ($y = 0; $y -lt $Height; $y++) {
    for ($x = 0; $x -lt $Width; $x++) {
      if ($final.GetPixel($x, $y).G -lt $Threshold) {
        $i = $y * $bytesPerRow + [int]($x / 8)
        $raster[$i] = $raster[$i] -bor (0x80 -shr ($x % 8))
        $on++
      }
    }
  }
  $final.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
  $final.Dispose()

  # GS v 0 m xL xH yL yH  d1..dk
  # Math::Floor, never [int]: PowerShell's [int] cast ROUNDS, so a height of 184
  # became a high byte of 1 and told the printer to expect 440 rows.
  $cmd = [byte[]]@(0x1D, 0x76, 0x30, 0x00,
                   ($bytesPerRow -band 0xFF), ([int][Math]::Floor($bytesPerRow / 256) -band 0xFF),
                   ($Height -band 0xFF), ([int][Math]::Floor($Height / 256) -band 0xFF))
  [System.IO.File]::WriteAllBytes($OutBin, ($cmd + $raster))

  [PSCustomObject]@{ Width = $Width; Height = $Height; Bytes = $cmd.Length + $raster.Length; Dots = $on }
}

$sources = Get-ChildItem -Path $AssetDir -Filter '*.txt' -ErrorAction SilentlyContinue
if (-not $sources) { throw "no .txt sources in $AssetDir" }

foreach ($src in $sources) {
  if ($src.BaseName -notmatch '^(.+)@(\d+)$') {
    throw "'$($src.Name)' must be named <asset-id>@<widthDots>.txt"
  }
  $id = $Matches[1]
  $large = [int]$Matches[2]
  # Read as UTF-8 explicitly: the console code page mangles Devanagari.
  $text = ([System.IO.File]::ReadAllText($src.FullName, [System.Text.Encoding]::UTF8)).Trim()
  if (-not $text) { throw "'$($src.Name)' is empty" }

  foreach ($variant in @(@{ Suffix = 's'; Fraction = 0.50 },
                         @{ Suffix = 'm'; Fraction = 0.75 },
                         @{ Suffix = 'l'; Fraction = 1.00 })) {
    # Round down to a multiple of 8: a raster row is whole bytes.
    $w = [int]([Math]::Floor($large * $variant.Fraction / 8) * 8)
    if ($w -lt 8) { throw "'$($src.Name)' is too small to make a $($variant.Suffix) variant" }
    $name = "$id-$($variant.Suffix)"
    $r = Convert-TextToRaster -Text $text -Width $w `
          -OutBin "$AssetDir\$name.bin" -OutPng "$AssetDir\$name.png"
    Write-Output ("{0,-12} {1}x{2} dots  {3} bytes  {4} dots on" -f $name, $r.Width, $r.Height, $r.Bytes, $r.Dots)
  }
}

Write-Output "check the .png files, then run: npm run inline-bitmap"
