@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "APP_ROOT=%~dp0"
if "%APP_ROOT:~-1%"=="\" set "APP_ROOT=%APP_ROOT:~0,-1%"

set "TARGET_EXE=%APP_ROOT%\gui\src-tauri\target\release\antigravity-proxy.exe"
set "TARGET_EXE2=%APP_ROOT%\gui\src-tauri\target\release\Antigravity Proxy.exe"
set "TARGET_DEBUG_EXE=%APP_ROOT%\gui\src-tauri\target\debug\antigravity-proxy.exe"

:: 1. 尝试直接启动已编译好的可执行文件（优先 Release，后 Debug，亦支持根目录便携版）
if exist "%TARGET_EXE%" (
  start "" "%TARGET_EXE%"
  exit /b 0
)
if exist "%TARGET_EXE2%" (
  start "" "%TARGET_EXE2%"
  exit /b 0
)
if exist "%APP_ROOT%\antigravity-proxy.exe" (
  start "" "%APP_ROOT%\antigravity-proxy.exe"
  exit /b 0
)
if exist "%APP_ROOT%\Antigravity-Proxy-Tauri.exe" (
  start "" "%APP_ROOT%\Antigravity-Proxy-Tauri.exe"
  exit /b 0
)
if exist "%TARGET_DEBUG_EXE%" (
  start "" "%TARGET_DEBUG_EXE%"
  exit /b 0
)

:: 2. 若未找到编译产物，尝试通过源码环境编译运行
set "PATH=%USERPROFILE%\.cargo\bin;%USERPROFILE%\AppData\Roaming\npm;%PATH%"

where cargo >nul 2>nul
if %ERRORLEVEL% neq 0 (
  echo =========================================================================
  echo [提示] 未找到现成的桌面客户端二进制文件，且未检测到 Rust (cargo) 编译环境。
  echo.
  echo 推荐方式:
  echo   1. 从 GitHub Releases 下载最新 Windows 预编译安装包或便携版:
  echo      https://github.com/MaaBlock/AntigravityProxy/releases
  echo.
  echo 源码开发:
  echo   2. 安装 Rust (https://rustup.rs/) 与 pnpm 后运行:
  echo      cd gui ^&^& pnpm install ^&^& pnpm build ^&^& cargo tauri build
  echo =========================================================================
  pause
  exit /b 1
)

:: 检查前端依赖与产物是否存在，若不存在则调用 pnpm install / build
pushd "%APP_ROOT%\gui"
where pnpm >nul 2>nul
if %ERRORLEVEL% equ 0 (
  if not exist "%APP_ROOT%\gui\node_modules" (
    echo [Antigravity Proxy] 正在安装前端依赖 (pnpm install)...
    call pnpm install
  )
  if not exist "%APP_ROOT%\gui\dist-web\index.html" (
    echo [Antigravity Proxy] 正在构建前端资源 (pnpm build)...
    call pnpm build
  )
) else (
  echo [警告] 未找到 pnpm 命令，跳过前端构建，尝试直接启动。
)
popd

echo [Antigravity Proxy] 正在启动桌面客户端...
pushd "%APP_ROOT%\gui\src-tauri" || (
  echo [错误] 无法进入目录: %APP_ROOT%\gui\src-tauri
  pause
  exit /b 1
)

cargo run --release
if %ERRORLEVEL% neq 0 (
  echo [错误] 启动或编译失败，错误代码: %ERRORLEVEL%
  pause
)

popd
exit /b 0