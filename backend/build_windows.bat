@echo off
setlocal
cd /d "%~dp0"

set "PY="
where py >nul 2>&1 && set "PY=py -3"
if "%PY%"=="" (
  where python >nul 2>&1 && set "PY=python"
)
if "%PY%"=="" (
  echo [!] Python 3 was not found on PATH. Install Python 3.9+ and re-run.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [*] Creating virtual environment in .venv ...
  %PY% -m venv .venv || goto :err
)

call ".venv\Scripts\activate.bat" || goto :err

echo [*] Installing runtime and build dependencies ...
python -m pip install --quiet --upgrade pip || goto :err
python -m pip install --quiet -r requirements.txt -r requirements-build.txt || goto :err

echo [*] Building dist\BatchSystemManager.exe ...
pyinstaller --noconfirm --clean BatchSystemManager.spec || goto :err

echo.
echo [OK] Built: %CD%\dist\BatchSystemManager.exe
echo      Double-click it to start the local app and open http://127.0.0.1:8765
goto :eof

:err
echo.
echo [X] Build failed. See the error above.
pause
exit /b 1
