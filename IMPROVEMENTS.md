# 改进记录（2026-11-16，本地改动，未推送、未部署）

参考的同类开源项目（只借思路和方法，没抄代码、没下外部代码）：

| 项目 | 借用的思路 |
|---|---|
| XCRDownloader (MohammadAliMehri/XCRDownloader, MIT) | YouTube 播放器客户端轮换：主客户端失败自动换 `android_vr,web_safari` → `tv` 等；错误信息人性化；优先给浏览器能直接播的含音频 MP4 |
| MeTube (alexta69/metube, ~15.3k★) | 限制并发解析任务数；yt-dlp 保持最新（Dockerfile 已是构建时装最新版）；cookie 是登录/受限视频的常规解法 |
| bzuer/dlp | 直接下 CDN 链接、服务器只做解析；区分直链/中转的思路（本站仍走原有直链 + /api/proxy） |
| Evil0ctal/Douyin_TikTok_Download_API (~21.4k★) | 抖音需要 X-Bogus 签名 + 新鲜 Cookie 才能稳定解析——确认本站抖音直解析失败时无 Cookie 可走是预期行为，未照搬其整套签名/身份池（太重，且涉及平台签名算法） |
| JoeanAmier/TikTokDownloader、yzfly/douyin-mcp-server | 同上：抖音/TikTok 解析本质上依赖 Cookie/签名 |

## 本次改动（server.js / public/index.html）

1. **YouTube 客户端轮换**（server.js `YT_CLIENT_CHAIN` + `parseYtDlp`）：按 `android,ios,web` → `android_vr,web_safari` → `tv,android,web` 顺序重试，任一成功即返回。本地实测三组都能解析 Rick Astley，`android_vr,web_safari` 也能解析养老金视频。
2. **错误信息分类**（`classifyYtDlpError`）：超时 / 403 反机器人 / 无可用格式 / 不支持链接 / 视频不可用，分别返回中文原因，不再一律“解析失败”。
3. **抖音解析加两层兜底**：直解析正则放宽到三种 `play_addr` 写法；直解析失败后改走 yt-dlp 的抖音提取器；仍失败则明确提示“疑似需要登录 Cookie”。
4. **格式排序改含音频优先**：含音频的合并格式排在前面并标注“含音频”，新增 `has_audio` 字段；之前高清 DASH 纯视频排前面，点下载会得到无声视频。
5. **/api/proxy 加 SSRF 防护**（`assertPublicUrl`）：目标与重定向目标都做 DNS 解析，拒绝 localhost/内网/169.254 等地址；只允许 http/https。
6. **并发上限**：同时解析超过 3 个返回 429“解析任务太多，请稍后再试”，保护 0.25 CPU 的免费容器。
7. **/api/info 入参校验**：非字符串、非法 URL、非 http/https 直接 400。
8. **前端**：结果卡片显示封面缩略图、时长（分:秒）、每个格式的文件大小。

## 刻意没做的事

- **没加 Cookie 支持**：Douyin_TikTok_Download_API / MeTube 都靠浏览器 Cookie 解决登录视频，但 Cookie 是活的登录会话，有效期短、风险大，按既定决定不接、不收用户 Cookie。
- **没加 TLS  impersonation（curl_cffi）/ deno**：XCRDownloader / dlp 用它们绕 YouTube 校验，但需要额外依赖和构建步骤，免费容器上收益不确定；客户端轮换已够解决当前已知失败。
- **没换架构**：没改成 MeTube 式的下载队列/订阅、没加数据库、没改 `/api/info`、`/api/proxy` 的接口形状和 3000 端口。
- **没动部署**：未推送 GitHub，未部署 SnapDeploy；线上仍是旧代码。
- **没做金鹰原图**：前端仍是 emoji 🦅 占位，原版金鹰素材不在仓库里。

## 本地验证

- `node --check server.js` 通过；本地 3001 端口启动后 `/api/info` 实测 Rick Astley 与养老金视频均解析成功（见测试记录）。
