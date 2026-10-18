# Renders the app icon (build/icon.png) — the same mark as LogoMark in
# src/ui/icons.tsx, on a fixed gradient. Re-run after changing the mark:
#
#   powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/make-icon.ps1
param(
  [string]$Out = (Join-Path $PSScriptRoot "..\build\icon.png"),
  [int]$Size = 1024
)

Add-Type -AssemblyName System.Drawing

$s = $Size / 24.0
$bmp = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

function New-RoundRect([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
  $p = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = [float]($r * 2)
  $p.AddArc([float]$x, [float]$y, $d, $d, 180, 90)
  $p.AddArc([float]($x + $w - $d), [float]$y, $d, $d, 270, 90)
  $p.AddArc([float]($x + $w - $d), [float]($y + $h - $d), $d, $d, 0, 90)
  $p.AddArc([float]$x, [float]($y + $h - $d), $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Hex([string]$c, [int]$alpha = 255) {
  $base = [System.Drawing.ColorTranslator]::FromHtml($c)
  return [System.Drawing.Color]::FromArgb($alpha, $base.R, $base.G, $base.B)
}

# Tile with a diagonal pink -> violet -> teal gradient.
$tile = New-RoundRect (1 * $s) (1 * $s) (22 * $s) (22 * $s) (7 * $s)
$grad = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.PointF]::new(0, 0), [System.Drawing.PointF]::new($Size, $Size),
  [System.Drawing.Color]::Black, [System.Drawing.Color]::White)
$blend = [System.Drawing.Drawing2D.ColorBlend]::new(3)
$blend.Colors = [System.Drawing.Color[]]@((Hex '#ff4f8b'), (Hex '#8b6bff'), (Hex '#3ee0d0'))
$blend.Positions = [single[]]@(0.0, 0.5, 1.0)
$grad.InterpolationColors = $blend
$g.FillPath($grad, $tile)

# Soft gloss over the top half.
$gloss = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.PointF]::new(0, 0), [System.Drawing.PointF]::new(0, $Size),
  [System.Drawing.Color]::White, [System.Drawing.Color]::White)
$glossBlend = [System.Drawing.Drawing2D.ColorBlend]::new(3)
$glossBlend.Colors = [System.Drawing.Color[]]@((Hex '#ffffff' 72), (Hex '#ffffff' 0), (Hex '#ffffff' 0))
$glossBlend.Positions = [single[]]@(0.0, 0.55, 1.0)
$gloss.InterpolationColors = $glossBlend
$g.FillPath($gloss, $tile)

# Equaliser bars that shrink left to right, tracing a play triangle (white).
$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
foreach ($bar in @(@(5.75, 12), @(8.65, 9.2), @(11.55, 6.4), @(14.45, 3.8), @(17.35, 1.9))) {
  $x = $bar[0]; $h = $bar[1]
  $g.FillPath($white, (New-RoundRect ($x * $s) ((12 - $h / 2) * $s) (1.9 * $s) ($h * $s) (0.95 * $s)))
}

$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "Wrote $Out ($Size x $Size)"
