param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-RoundedPath {
  param(
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $Radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-LinearBrush {
  param(
    [System.Drawing.RectangleF]$Bounds,
    [string]$Start,
    [string]$End,
    [float]$Angle = 45
  )
  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($Bounds, [System.Drawing.ColorTranslator]::FromHtml($Start), [System.Drawing.ColorTranslator]::FromHtml($End), $Angle)
  return $brush
}

function Save-ResizedPng {
  param(
    [System.Drawing.Bitmap]$Source,
    [int]$Size,
    [string]$Path
  )
  $target = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($target)
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.DrawImage($Source, [System.Drawing.Rectangle]::new(0, 0, $Size, $Size))
  $graphics.Dispose()
  $target.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $target.Dispose()
}

function Write-Ico {
  param(
    [string]$Path,
    [int[]]$Sizes,
    [System.Drawing.Bitmap]$Source
  )
  $frames = @()
  foreach ($size in $Sizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage($Source, [System.Drawing.Rectangle]::new(0, 0, $size, $size))
    $graphics.Dispose()
    $stream = [System.IO.MemoryStream]::new()
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    $frames += [pscustomobject]@{ Size = $size; Bytes = $stream.ToArray() }
    $stream.Dispose()
  }

  $file = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  $writer = [System.IO.BinaryWriter]::new($file)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$frames.Count)
    $offset = 6 + 16 * $frames.Count
    foreach ($frame in $frames) {
      $dimension = if ($frame.Size -ge 256) { 0 } else { $frame.Size }
      $writer.Write([byte]$dimension)
      $writer.Write([byte]$dimension)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$frame.Bytes.Length)
      $writer.Write([uint32]$offset)
      $offset += $frame.Bytes.Length
    }
    foreach ($frame in $frames) { $writer.Write($frame.Bytes) }
  } finally {
    $writer.Dispose()
    $file.Dispose()
  }
}

$bitmap = [System.Drawing.Bitmap]::new(1024, 1024, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::Transparent)
$graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

$tilePath = New-RoundedPath 42 42 940 940 224
$tileBrush = New-LinearBrush ([System.Drawing.RectangleF]::new(42, 42, 940, 940)) '#25352f' '#0c1411' 50
$graphics.FillPath($tileBrush, $tilePath)
$tileBrush.Dispose()
$tileBorder = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(135, 94, 118, 108), 8)
$graphics.DrawPath($tileBorder, $tilePath)
$tileBorder.Dispose()
$tilePath.Dispose()

$highlight = [System.Drawing.Drawing2D.GraphicsPath]::new()
$highlight.AddBezier(42, 292, 170, 106, 333, 55, 512, 55)
$highlight.AddBezier(512, 55, 691, 55, 854, 106, 982, 292)
$highlight.AddLine(982, 264)
$highlight.AddBezier(982, 264, 842, 98, 690, 42, 512, 42)
$highlight.AddBezier(512, 42, 334, 42, 182, 98, 42, 264)
$highlight.CloseFigure()
$highlightBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(14, 255, 255, 255))
$graphics.FillPath($highlightBrush, $highlight)
$highlightBrush.Dispose()
$highlight.Dispose()

function Draw-BackCard {
  param([float]$Angle, [string]$Fill, [string]$Stroke, [string]$Ink)
  $state = $graphics.Save()
  $graphics.TranslateTransform(512, 520)
  $graphics.RotateTransform($Angle)
  $graphics.TranslateTransform(-512, -520)
  $card = New-RoundedPath 270 185 484 650 86
  $brush = New-LinearBrush ([System.Drawing.RectangleF]::new(270, 185, 484, 650)) $Fill $Fill 45
  $graphics.FillPath($brush, $card)
  $brush.Dispose()
  $pen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml($Stroke), 11)
  $graphics.DrawPath($pen, $card)
  $pen.Dispose()
  $bar = New-RoundedPath 330 265 364 56 28
  $barBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(220, [System.Drawing.ColorTranslator]::FromHtml($Ink)))
  $graphics.FillPath($barBrush, $bar)
  $barBrush.Dispose()
  $bar.Dispose()
  $line = New-RoundedPath 330 351 272 32 16
  $lineBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(96, [System.Drawing.ColorTranslator]::FromHtml($Ink)))
  $graphics.FillPath($lineBrush, $line)
  $lineBrush.Dispose()
  $line.Dispose()
  $card.Dispose()
  $graphics.Restore($state)
}

Draw-BackCard -Angle -12 -Fill '#3f6555' -Stroke '#78978a' -Ink '#dff3ea'
Draw-BackCard -Angle 12 -Fill '#c99d55' -Stroke '#efd096' -Ink '#fff1d3'

$shadow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(64, 0, 0, 0))
$graphics.FillEllipse($shadow, 185, 790, 654, 92)
$shadow.Dispose()

$frontPath = New-RoundedPath 266 172 492 676 92
$frontBrush = New-LinearBrush ([System.Drawing.RectangleF]::new(266, 172, 492, 676)) '#fffdf7' '#d9eee5' 90
$graphics.FillPath($frontBrush, $frontPath)
$frontBrush.Dispose()
$frontBorder = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#fffdf7'), 14)
$graphics.DrawPath($frontBorder, $frontPath)
$frontBorder.Dispose()
$frontPath.Dispose()

$statusBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#e3a84b'))
$graphics.FillEllipse($statusBrush, 662, 232, 56, 56)
$statusBrush.Dispose()
$statusInner = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#fff5dd'))
$graphics.FillEllipse($statusInner, 678, 248, 24, 24)
$statusInner.Dispose()

$networkPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#17483b'), 38)
$networkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$networkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($networkPen, 512, 510, 407, 390)
$graphics.DrawLine($networkPen, 512, 510, 617, 390)
$graphics.DrawLine($networkPen, 512, 510, 512, 640)
$networkPen.Dispose()

$centerOuter = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#143b31'))
$graphics.FillEllipse($centerOuter, 432, 430, 160, 160)
$centerOuter.Dispose()
$centerInner = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#48c7a0'))
$graphics.FillEllipse($centerInner, 481, 479, 62, 62)
$centerInner.Dispose()

$nodeFill = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#17483b'))
$nodeStroke = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#36b58d'), 10)
foreach ($node in @(@(407, 390), @(617, 390), @(512, 640))) {
  $graphics.FillEllipse($nodeFill, $node[0] - 42, $node[1] - 42, 84, 84)
  $graphics.DrawEllipse($nodeStroke, $node[0] - 42, $node[1] - 42, 84, 84)
}
$nodeFill.Dispose()
$nodeStroke.Dispose()
$nodeDot = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#dff7ed'))
foreach ($node in @(@(407, 390), @(617, 390), @(512, 640))) {
  $graphics.FillEllipse($nodeDot, $node[0] - 12, $node[1] - 12, 24, 24)
}
$nodeDot.Dispose()
$graphics.Dispose()

$bitmap.Save((Join-Path $Root 'resources\icon-master-v2.png'), [System.Drawing.Imaging.ImageFormat]::Png)
Save-ResizedPng -Source $bitmap -Size 512 -Path (Join-Path $Root 'resources\icon.png')
Write-Ico -Path (Join-Path $Root 'resources\icon.ico') -Sizes @(16, 20, 24, 32, 40, 48, 64, 128, 256) -Source $bitmap
$bitmap.Dispose()

Write-Output 'Icon assets generated.'
