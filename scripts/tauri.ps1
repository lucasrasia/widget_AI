param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TauriArguments
)

$env:RUSTUP_HOME = Join-Path $env:LOCALAPPDATA 'WidgetaAI\rustup'
$env:CARGO_HOME = Join-Path $env:USERPROFILE '.cargo'
$cargoBin = Join-Path $env:CARGO_HOME 'bin'

$env:PATH = "$cargoBin;$env:PATH"
& (Join-Path $cargoBin 'rustc.exe') --version *> $null
if ($LASTEXITCODE -ne 0) { throw 'A toolchain Rust isolada do WidgetaAI não está pronta.' }
& npx.cmd tauri @TauriArguments
exit $LASTEXITCODE
