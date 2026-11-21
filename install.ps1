# Instala a skill MyFriends no Claude Code, no Codex e no Antigravity (só onde a IDE existir).
#   powershell -ExecutionPolicy Bypass -File install.ps1          mostra o plano e pede confirmação
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Yes     instala sem perguntar
#   ... -Only claude,codex
param([switch]$Yes, [string]$Only = "", [switch]$Force)
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
if ($Yes) { & node $script --yes @extra; exit $LASTEXITCODE }
& node $script @extra
$ans = Read-Host "`nInstalar agora? [s/N]"
if ($ans -match '^(s|sim|y|yes)$') { & node $script --yes @extra } else { Write-Host "Nada foi alterado." }
