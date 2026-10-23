. "$PSScriptRoot/environment.ps1"
$jbWslRoot=(& wsl.exe -d JavaBlueprints -- wslpath -a $jbRoot.Replace('\','/')).Trim()
& wsl.exe -d JavaBlueprints -u root -- docker compose --env-file "$jbWslRoot/.env" -f "$jbWslRoot/infra/compose.yaml" up -d db
if($LASTEXITCODE){throw 'Database start failed'}
& ./mvnw.cmd -B -ntp test
if($LASTEXITCODE){throw 'Tests failed'}
