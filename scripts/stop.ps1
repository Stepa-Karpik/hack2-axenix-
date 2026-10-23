. "$PSScriptRoot/environment.ps1"
$jbWslRoot=(& wsl.exe -d JavaBlueprints -- wslpath -a $jbRoot.Replace('\','/')).Trim()
& wsl.exe -d JavaBlueprints -u root -- docker compose --env-file "$jbWslRoot/.env" -f "$jbWslRoot/infra/compose.yaml" down
if($LASTEXITCODE){throw 'Compose shutdown failed'}
Write-Output 'Services stopped. PostgreSQL data is retained in its named volume.'
