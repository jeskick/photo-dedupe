@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 https://nodejs.org/ 后重新打开本文件。
  pause
  exit /b 1
)

set "VENV=D:\AI_DATA\photo-dedupe\venv"
call :pickpython
if exist "%VENV%\Scripts\python.exe" (
  "%VENV%\Scripts\python.exe" -c "import sys; raise SystemExit(0 if 'free-threading' not in sys.version else 1)" >nul 2>nul
  if errorlevel 1 (
    if defined PYLAUNCH (
      echo 当前画面比对环境是免 GIL 的 Python，预编译库装不上，正在改用普通 Python...
      rmdir /s /q "%VENV%"
    ) else (
      echo 免 GIL 的 Python 装不上画面比对库。完全相同的文件仍可查重。
      echo 请安装普通 Python 3.12：https://www.python.org/downloads/
    )
  )
)

if not exist "%VENV%\Scripts\python.exe" (
  if not defined PYLAUNCH (
    echo 未找到可用的 Python。完全相同的文件仍可查重。
    echo 画面相似和 HEIC 预览需要普通 Python 3.12：https://www.python.org/downloads/
    goto start
  )
  echo 正在准备画面比对环境，第一次需要联网，请稍候...
  %PYLAUNCH% -m venv "%VENV%"
  if not exist "%VENV%\Scripts\python.exe" (
    echo Python 环境没有准备好，将只查重内容完全相同的文件。
    goto start
  )
)

"%VENV%\Scripts\python.exe" -c "import PIL, imagehash, pillow_heif" >nul 2>nul
if errorlevel 1 (
  echo 正在安装画面比对库，需要联网，请稍候...
  "%VENV%\Scripts\python.exe" -m pip install --cache-dir D:\AI_DATA\pip-cache --only-binary=pillow,numpy,scipy,PyWavelets,pillow-heif -r python\requirements.txt
  if errorlevel 1 (
    echo 画面比对库安装失败。完全相同的文件仍可查重。
  )
)

if not exist "%SystemRoot%\System32\vcruntime140_1.dll" (
  echo 人物识别需要较新的 Visual C++ 运行库，正在安装...
  winget install --id Microsoft.VCRedist.2015+.x64 -e --accept-package-agreements --accept-source-agreements
  if not exist "%SystemRoot%\System32\vcruntime140_1.dll" (
    echo 运行库还没装上。请安装 https://aka.ms/vs/17/release/vc_redist.x64.exe 后再识别人物。
    echo 没装上时，浏览和查重仍然可用。
  )
)

"%VENV%\Scripts\python.exe" -c "import insightface, onnxruntime, cv2" >nul 2>nul
if errorlevel 1 (
  echo 正在安装人物识别组件，需要联网。装不上也不影响浏览和查重。
  "%VENV%\Scripts\python.exe" -m pip install --cache-dir D:\AI_DATA\pip-cache insightface onnxruntime opencv-python-headless
)

:start
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-boot-task.ps1" -Bat "%~dp0开机启动.bat" >nul 2>nul
if errorlevel 2 (
  echo 正在登记开机自动运行，请允许本次管理员权限...
  powershell -NoProfile -Command "Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0install-boot-task.ps1','-Bat','%~dp0开机启动.bat'"
)
node src\server.js
if errorlevel 1 pause
exit /b 0

:pickpython
set "PYLAUNCH="
for /d %%D in ("D:\AI_DATA\python\cpython-3.12*") do (
  if exist "%%D\python.exe" (
    "%%D\python.exe" -c "import sys; raise SystemExit(0 if 'free-threading' not in sys.version else 1)" >nul 2>nul
    if not errorlevel 1 (
      set "PYLAUNCH=%%D\python.exe"
      goto :eof
    )
  )
)
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
