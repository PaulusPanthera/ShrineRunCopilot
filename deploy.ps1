# deploy.ps1
$src  = "C:\Users\paulb\OneDrive\Desktop\Beneath Open Roads\Tool PokeMMO"
$dest = "C:\Users\paulb\OneDrive\Desktop\Beneath Open Roads\ShrineRunCopilot_repo"

# Safety checks
if (!(Test-Path $src))  { throw "Source folder not found: $src" }
if (!(Test-Path $dest)) { throw "Repo folder not found: $dest" }
if (!(Test-Path (Join-Path $dest ".git"))) { throw "Dest is not a git repo (missing .git): $dest" }

Set-Location $dest

Write-Host "== git pull --rebase ==" -ForegroundColor Cyan
git pull --rebase

Write-Host "== robocopy mirror (with exclusions) ==" -ForegroundColor Cyan
robocopy $src $dest /MIR `
  /XD ".git" "node_modules" ".vscode" "logs" "additional assets" "additonal assets" `
  /XF ".DS_Store" "thumbs.db" ".gitignore" | Out-Host

Write-Host "== git status ==" -ForegroundColor Cyan
git status

Write-Host "== git add -A ==" -ForegroundColor Cyan
git add -A

# Commit only if there are staged changes
$hasChanges = git diff --cached --name-only
if ([string]::IsNullOrWhiteSpace($hasChanges)) {
  Write-Host "No changes to commit." -ForegroundColor Green
  exit 0
}

$msg = "Update from local $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
Write-Host "== git commit: $msg ==" -ForegroundColor Cyan
git commit -m $msg

Write-Host "== git push ==" -ForegroundColor Cyan
git push

Write-Host "Done." -ForegroundColor Green