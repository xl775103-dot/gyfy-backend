#!/bin/bash
# 鹏哥视频解析 - 一键部署脚本
# 用法: bash deploy.sh

set -e

APP_DIR="/opt/pengge-video"

echo "=== 安装 Node.js 20 ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "=== 安装 yt-dlp ==="
apt-get install -y python3-pip
pip3 install yt-dlp --break-system-packages

echo "=== 部署应用 ==="
mkdir -p $APP_DIR
cp -r . $APP_DIR/
cd $APP_DIR
npm install --production

echo "=== 创建系统服务 ==="
cat > /etc/systemd/system/pengge-video.service << 'EOF'
[Unit]
Description=Pengge Video Parser
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/pengge-video
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pengge-video
systemctl start pengge-video

echo ""
echo "=== 部署完成! ==="
echo "服务状态: systemctl status pengge-video"
echo "查看日志: journalctl -u pengge-video -f"
echo "访问: http://$(hostname -I | awk '{print $1}'):3000"
