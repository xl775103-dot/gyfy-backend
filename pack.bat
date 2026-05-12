@echo off
echo 打包项目用于上传到服务器...
cd /d %~dp0
tar -czf pengge-video.tar.gz --exclude=node_modules --exclude=*.tar.gz --exclude=*.bat --exclude=deploy.sh .
echo 打包完成: pengge-video.tar.gz
echo.
echo 上传到服务器后执行:
echo   tar -xzf pengge-video.tar.gz
echo   bash deploy.sh
pause
