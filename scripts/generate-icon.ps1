# Generates build/icon.png (1024) for electron-builder and the app window/tray.
Add-Type -AssemblyName System.Drawing

function Get-RoundedRectPath([int]$X, [int]$Y, [int]$W, [int]$H, [int]$R) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [Math]::Min($R * 2, [Math]::Min($W, $H))
  $path.AddArc($X, $Y, $d, $d, 180, 90)
  $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
  $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
  $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

$size = 1024
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

$pad = 48
$corner = 220
$bg = Get-RoundedRectPath $pad $pad ($size - 2 * $pad) ($size - 2 * $pad) $corner
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 26, 115, 232))
$g.FillPath($brush, $bg)

$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$cx = 390
$cy = 512
$dot = 70
$g.FillEllipse($white, $cx - $dot, $cy - $dot, $dot * 2, $dot * 2)

$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 56
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
foreach ($r in @(180, 310, 440)) {
  $rect = New-Object System.Drawing.Rectangle ($cx - $r), ($cy - $r), ($r * 2), ($r * 2)
  $g.DrawArc($pen, $rect, -55, 110)
}

$destDir = Join-Path $PSScriptRoot "..\build"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
$dest = Join-Path $destDir "icon.png"
$bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)

$g.Dispose()
$bmp.Dispose()
$brush.Dispose()
$white.Dispose()
$pen.Dispose()
$bg.Dispose()

Write-Host "Wrote $dest"
