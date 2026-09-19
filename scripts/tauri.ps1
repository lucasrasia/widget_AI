param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TauriArguments
)

$ErrorActionPreference = 'Stop'

function Import-WidgetaMicrosoftToolchain {
  $vswhereCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe')
  )
  $vswhere = $vswhereCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $vswhere) {
    throw 'Visual Studio 2022 Build Tools nao encontrado. Instale Desktop development with C++ e um Windows SDK.'
  }

  $installationPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($LASTEXITCODE -ne 0 -or -not $installationPath) {
    throw 'O componente MSVC x64 nao foi encontrado no Visual Studio Build Tools.'
  }

  $vsDevCmd = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path -LiteralPath $vsDevCmd)) {
    throw "VsDevCmd.bat nao encontrado em $installationPath."
  }

  $environmentLines = & $env:ComSpec /d /s /c "`"$vsDevCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
  if ($LASTEXITCODE -ne 0) {
    throw 'Nao foi possivel carregar o ambiente de compilacao do Visual Studio.'
  }
  foreach ($line in $environmentLines) {
    if ($line -match '^([^=]+)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }

  $linker = Get-Command link.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $msvcPath = Join-Path $installationPath 'VC\Tools\MSVC'
  if (-not $linker -or -not $linker.Source.StartsWith("$msvcPath\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'O linker MSVC nao esta ativo; o build nao deve usar o link.exe do Git.'
  }
  if (-not (Get-Command rc.exe -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'Windows SDK nao encontrado: rc.exe nao esta disponivel no ambiente de build.'
  }
}

Import-WidgetaMicrosoftToolchain

$env:RUSTUP_HOME = Join-Path $env:LOCALAPPDATA 'WidgetaAI\rustup'
$env:CARGO_HOME = Join-Path $env:USERPROFILE '.cargo'
$cargoBin = Join-Path $env:CARGO_HOME 'bin'

$env:PATH = "$cargoBin;$env:PATH"
& (Join-Path $cargoBin 'rustc.exe') --version *> $null
if ($LASTEXITCODE -ne 0) { throw 'A toolchain Rust isolada do WidgetaAI não está pronta.' }

if ($TauriArguments.Count -eq 1 -and $TauriArguments[0] -eq 'check') {
  & (Join-Path $cargoBin 'cargo.exe') test --manifest-path src-tauri\Cargo.toml
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & (Join-Path $cargoBin 'cargo.exe') check --manifest-path src-tauri\Cargo.toml
  exit $LASTEXITCODE
}

& npx.cmd tauri @TauriArguments
exit $LASTEXITCODE
