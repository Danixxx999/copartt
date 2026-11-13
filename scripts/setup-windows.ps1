# copart - instalación inicial en una máquina Windows nueva (sin permisos de administrador).
# Descarga Node.js LTS y PostgreSQL portables en .tools\, crea la base de datos, instala dependencias,
# aplica migraciones y carga los datos de demostración.
#   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root '.tools'
New-Item -ItemType Directory -Force $tools | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$NodeVersion = 'v24.22.2'
$PgVersion = '17.10-1'

if (-not (Test-Path "$tools\node\node.exe")) {
  Write-Host "Descargando Node.js $NodeVersion..."
  $zip = "$tools\node.zip"
  Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip" -OutFile $zip
  Expand-Archive $zip -DestinationPath $tools -Force
  Rename-Item "$tools\node-$NodeVersion-win-x64" 'node'
  Remove-Item $zip
}
if (-not (Test-Path "$tools\pgsql\bin\postgres.exe")) {
  Write-Host "Descargando PostgreSQL $PgVersion (unos 330 MB)..."
  $zip = "$tools\pg.zip"
  Invoke-WebRequest "https://get.enterprisedb.com/postgresql/postgresql-$PgVersion-windows-x64-binaries.zip" -OutFile $zip
  Expand-Archive $zip -DestinationPath $tools -Force
  Remove-Item $zip
  Remove-Item -Recurse -Force "$tools\pgsql\pgAdmin 4", "$tools\pgsql\doc", "$tools\pgsql\StackBuilder" -ErrorAction SilentlyContinue
}
$env:Path = "$tools\node;$env:Path"
if (-not (Test-Path "$tools\pgdata")) {
  Write-Host 'Inicializando el cluster de PostgreSQL (puerto 5433)...'
  Set-Content "$tools\pwfile" 'copart_dev' -NoNewline
  & "$tools\pgsql\bin\initdb.exe" -D "$tools\pgdata" -U postgres --pwfile="$tools\pwfile" -E UTF8 --locale=C -A scram-sha-256 | Out-Null
  Remove-Item "$tools\pwfile"
  & "$tools\pgsql\bin\pg_ctl.exe" -D "$tools\pgdata" -o '-p 5433' -l "$tools\pg.log" -w start
  $env:PGPASSWORD = 'copart_dev'
  & "$tools\pgsql\bin\psql.exe" -h 127.0.0.1 -p 5433 -U postgres -c 'CREATE DATABASE copart;' -c 'CREATE DATABASE copart_test;'
} else {
  & "$tools\pgsql\bin\pg_ctl.exe" -D "$tools\pgdata" status | Out-Null
  if ($LASTEXITCODE -ne 0) { & "$tools\pgsql\bin\pg_ctl.exe" -D "$tools\pgdata" -o '-p 5433' -l "$tools\pg.log" -w start }
}
Set-Location $root
if (-not (Test-Path '.env')) {
  $secret = & node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  (Get-Content '.env.example') -replace '^APP_SECRET=.*', "APP_SECRET=$secret" | Set-Content '.env' -Encoding utf8
}
Write-Host 'Instalando dependencias npm...'
& "$tools\node\npm.cmd" install --no-audit --no-fund
& node scripts\seed.js
Write-Host "`nListo. Ejecuta INICIAR.bat o 'npm start' y abre http://localhost:3000" -ForegroundColor Green
