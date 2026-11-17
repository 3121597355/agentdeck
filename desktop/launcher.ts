import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

const psQuote = (text: string) => "'" + text.replace(/'/g, "''") + "'";
export function writeWindowsLauncher(options: {path:string; exe:string; cli:string; source:string; root:string; sqlite:string}) {
  const {path,exe,cli,source,root,sqlite} = options;
  mkdirSync(dirname(path), {recursive:true});
  copyFileSync(source, cli);
  const script = `param([Parameter(ValueFromRemainingArguments=$true)][string[]]$HookArgs)\n` +
    `$ErrorActionPreference='Stop'\n$OutputEncoding=[Console]::OutputEncoding=[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)\n` +
    `$env:ELECTRON_RUN_AS_NODE='1'\n$env:AGENT_INBOX_HOME=${psQuote(root)}\n$env:AGENT_INBOX_SQLITE=${psQuote(sqlite)}\n` +
    `$payload=if([Console]::IsInputRedirected){[Console]::In.ReadToEnd()}else{''}\n` + String.raw`
function Quote-NativeArgument([string]$Value) {
  $escaped=[regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped=[regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}
try {
  $start=[System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName=${psQuote(exe)}
  $start.Arguments=((@(${psQuote(cli)}) + $HookArgs) | ForEach-Object {Quote-NativeArgument $_}) -join ' '
  $start.UseShellExecute=$false
  $start.CreateNoWindow=$true
  $start.RedirectStandardInput=$true
  $start.RedirectStandardOutput=$true
  $start.RedirectStandardError=$true
  $process=[System.Diagnostics.Process]::new()
  $process.StartInfo=$start
  [void]$process.Start()
  $output=$process.StandardOutput.ReadToEndAsync()
  $errors=$process.StandardError.ReadToEndAsync()
  $bytes=[System.Text.Encoding]::UTF8.GetBytes($payload)
  $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length)
  $process.StandardInput.Close()
  if(-not $process.WaitForExit(10000)) { $process.Kill(); exit 0 }
  [Console]::Out.Write($output.GetAwaiter().GetResult())
  [Console]::Error.Write($errors.GetAwaiter().GetResult())
  $process.Dispose()
  exit 0
} catch { exit 0 }
`;
  writeFileSync(path, "\uFEFF" + script, "utf8");
}
