@echo off
REM copart - arranque con un doble clic (Windows). Usa Node y PostgreSQL portables de la carpeta .tools
cd /d "%~dp0"
if not exist ".tools\node\node.exe" (
  echo No se encontraron las herramientas. Ejecutando instalacion inicial...
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
  if errorlevel 1 ( echo La instalacion fallo. & pause & exit /b 1 )
)
set "PATH=%~dp0.tools\node;%PATH%"
call node scripts\db.js status >nul 2>nul || call node scripts\db.js start
call node scripts\migrate.js
echo.
echo  Abre http://localhost:3000 en tu navegador. Cierra esta ventana para detener el servidor.
echo.
start "" http://localhost:3000
node src\server.js
pause
