# Instala o MyFriends nas IDEs encontradas: skill (Claude Code, Codex, Antigravity) e MCP (Cursor, Copilot, VS Code...).
#   powershell -ExecutionPolicy Bypass -File install.ps1          mostra o plano e pede confirmação
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Yes     instala sem perguntar
#   ... -Only claude,codex,cursor   -NoHooks   -NoMcp   -Uninstall
param([switch]$Yes, [string]$Only = "", [switch]$Force, [switch]$NoHooks, [switch]$NoMcp, [switch]$Uninstall)
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error "O MyFriends precisa do Node.js 18 ou mais novo (https://nodejs.org). Instale e rode de novo."; exit 1 }
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) { Write-Error "Node.js $major encontrado; o MyFriends precisa do 18 ou mais novo."; exit 1 }
$script = Join-Path $dir "scripts\install.js"
$extra = @()
if ($Only) { $extra += @("--only", $Only) }
if ($Force) { $extra += "--force" }
if ($NoHooks) { $extra += "--no-hooks" }
if ($NoMcp) { $extra += "--no-mcp" }
if ($Uninstall) { & node $script --uninstall; exit $LASTEXITCODE }
if ($Yes) { $extra += "--yes" }
& node $script @extra
exit $LASTEXITCODE
