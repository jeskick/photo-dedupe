@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 https://nodejs.org/ 后重新打开本文件。
  pause
  exit /b 1
)

call :pickpython
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import sys; raise SystemExit(0 if 'free-threading' not in sys.version else 1)" >nul 2>nul
  if errorlevel 1 (
    if defined PYLAUNCH (
      echo 当前画面比对环境是免 GIL 的 Python，预编译库装不上，正在改用普通 Python...
      rmdir /s /q ".venv"
    ) else (
      echo 免 GIL 的 Python 装不上画面比对库。完全相同的文件仍可查重。
      echo 请安装普通 Python 3.12：https://www.python.org/downloads/
    )
  )
)

if not exist ".venv\Scripts\python.exe" (
  if not defined PYLAUNCH (
    echo 未找到可用的 Python。完全相同的文件仍可查重。
    echo 画面相似和 HEIC 预览需要普通 Python 3.12：https://www.python.org/downloads/
    goto start
  )
  echo 正在准备画面比对环境，第一次需要联网，请稍候...
  %PYLAUNCH% -m venv .venv
  if not exist ".venv\Scripts\python.exe" (
    echo Python 环境没有准备好，将只查重内容完全相同的文件。
    goto start
  )
)

".venv\Scripts\python.exe" -c "import PIL, imagehash, pillow_heif" >nul 2>nul
if errorlevel 1 (
  echo 正在安装画面比对库，需要联网，请稍候...
  ".venv\Scripts\python.exe" -m pip install --only-binary=pillow,numpy,scipy,PyWavelets,pillow-heif -r python\requirements.txt
  if errorlevel 1 (
    echo 画面比对库安装失败。完全相同的文件仍可查重。
  )
)

:start
node src\server.js
if errorlevel 1 pause
exit /b 0

:pickpython
set "PYLAUNCH="
where py >nul 2>nul
if errorlevel 1 goto pickplain
py -3.12 -c "import sys; raise SystemExit(0 if 'free-threading' not in sys.version else 1)" >nul 2>nul
if not errorlevel 1 (
  set "PYLAUNCH=py -3.12"
  goto :eof
)
py -3.13 -c "import sys; raise SystemExit(0 if 'free-threading' not in sys.version else 1)" >nul 2>nul
if not errorlevel 1 (
  set "PYLAUNCH=py -3.13"
  goto :eof
)
py -3 -c "import sys; raise SystemExit(0 if 'free-threading' not in sys.version else 1)" >nul 2>nul
if not errorlevel 1 (
  set "PYLAUNCH=py -3"
  goto :eof
)
:pickplain
where python >nul 2>nul
if errorlevel 1 goto :eof
python -c "import sys; raise SystemExit(0 if 'free-threading' not in sys.version else 1)" >nul 2>nul
if not errorlevel 1 set "PYLAUNCH=python"
goto :eof
