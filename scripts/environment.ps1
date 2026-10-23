$ErrorActionPreference='Stop'
$jbRoot=Split-Path $PSScriptRoot -Parent
Set-Location $jbRoot
if(-not $env:JAVA_HOME){$jbPortable=Get-ChildItem "$jbRoot/.local/tools/jdk21" -Directory -ErrorAction SilentlyContinue|Select-Object -First 1;if($jbPortable){$env:JAVA_HOME=$jbPortable.FullName}}
if($env:JAVA_HOME){$env:Path="$env:JAVA_HOME/bin;$env:Path"}
$env:MAVEN_USER_HOME="$jbRoot/.local/cache/maven-wrapper"
if(-not(Test-Path .env)){Copy-Item .env.example .env}
$jbConfig=Get-Content .env -Raw
if($jbConfig -match '(?m)^JB_DB_PASSWORD=(?:replace_with_local_random_secret)?\s*$'){$jbSecret=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32));$jbConfig=[regex]::Replace($jbConfig,'(?m)^JB_DB_PASSWORD=.*$',"JB_DB_PASSWORD=$jbSecret")}
if($jbConfig -match '(?m)^JB_RUNNER_CONTROLLER_TOKEN=\s*$'){$jbSecret=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32));$jbConfig=[regex]::Replace($jbConfig,'(?m)^JB_RUNNER_CONTROLLER_TOKEN=.*$',"JB_RUNNER_CONTROLLER_TOKEN=$jbSecret")}
[IO.File]::WriteAllText("$jbRoot/.env",$jbConfig,[Text.UTF8Encoding]::new($false))
foreach($jbLine in Get-Content .env){if($jbLine -match '^([A-Z][A-Z0-9_]*)=(.*)$'){[Environment]::SetEnvironmentVariable($Matches[1],$Matches[2],'Process')}}
# Keep this project distribution awake while native Windows Java accesses its database.
$jbKeepaliveFile=Join-Path $jbRoot '.local/wsl-keepalive.pid'
$jbExistingPid=if(Test-Path $jbKeepaliveFile){Get-Content $jbKeepaliveFile -ErrorAction SilentlyContinue}else{$null}
$jbExistingProcess=if($jbExistingPid){Get-Process -Id $jbExistingPid -ErrorAction SilentlyContinue}else{$null}
if(-not $jbExistingProcess -or $jbExistingProcess.ProcessName -ne 'wsl'){
 $jbKeepAlive=Start-Process -FilePath wsl.exe -ArgumentList @('-d','JavaBlueprints','--','sleep','infinity') -WindowStyle Hidden -PassThru
 New-Item -ItemType Directory -Force (Join-Path $jbRoot '.local') | Out-Null
 Set-Content -LiteralPath $jbKeepaliveFile -Value $jbKeepAlive.Id
}
# Optional paths for portable Node/pnpm, kept in private .env.
foreach($jbToolHome in @($env:JB_NODE_HOME,$env:JB_PNPM_HOME)) {if($jbToolHome){$env:Path="$jbToolHome;$env:Path"}}
