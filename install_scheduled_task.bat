@echo off
chcp 65001 >nul
echo ========================================
echo   安装电台台标抓取定时任务
echo   每天凌晨3:00自动执行
echo ========================================
echo.

set TASK_NAME=RetroRadioLogoFetcher
set SCRIPT_PATH=%~dp0fetch_logos.bat
set SCRIPT_PATH=%SCRIPT_PATH:\=\\%

echo 正在检查是否已存在同名任务...
schtasks /Query /TN "%TASK_NAME%" >nul 2>&1
if %errorlevel%==0 (
    echo 发现已存在的任务，正在删除...
    schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1
    if %errorlevel%==0 (
        echo 旧任务已删除
    ) else (
        echo 删除旧任务失败，请手动检查
    )
)

echo.
echo 正在创建定时任务...
echo 执行时间: 每天 03:00
echo 执行脚本: %~dp0fetch_logos.bat
echo.

schtasks /Create /TN "%TASK_NAME%" /TR "\"%~dp0fetch_logos.bat\"" /SC DAILY /ST 03:00 /RL HIGHEST /F

if %errorlevel%==0 (
    echo.
    echo ========================================
    echo   定时任务创建成功！
    echo   任务名称: %TASK_NAME%
    echo   执行时间: 每天凌晨 3:00
    echo ========================================
) else (
    echo.
    echo ========================================
    echo   任务创建失败，请以管理员身份运行此脚本
    echo ========================================
)

echo.
pause
