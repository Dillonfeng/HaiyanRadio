@echo off
chcp 65001 >nul
echo ========================================
echo   卸载电台台标抓取定时任务
echo ========================================
echo.

set TASK_NAME=RetroRadioLogoFetcher

echo 正在检查任务是否存在...
schtasks /Query /TN "%TASK_NAME%" >nul 2>&1
if %errorlevel%==0 (
    echo 找到任务，正在删除...
    schtasks /Delete /TN "%TASK_NAME%" /F
    if %errorlevel%==0 (
        echo.
        echo ========================================
        echo   任务已成功卸载
        echo ========================================
    ) else (
        echo.
        echo ========================================
        echo   卸载失败，请以管理员身份运行
        echo ========================================
    )
) else (
    echo.
    echo ========================================
    echo   未找到该任务，无需卸载
    echo ========================================
)

echo.
pause
