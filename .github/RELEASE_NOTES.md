## MobileTV v1.0.2

MobileTV 首个公开开源发行版，将 Windows 电脑变成手机的局域网媒体投屏接收端。

### 下载选择

- **`MobileTV-1.0.2-Setup-x64.exe`**：推荐普通用户使用。当前用户安装，中英文安装界面、开始菜单入口、可选桌面快捷方式和卸载程序。
- **`MobileTV-1.0.2-win-x64-*.zip`**：免安装版。完整解压后双击 `MobileTV.exe`，不要只复制 EXE。
- **`SHA256SUMS.txt`**：以上附件的 SHA-256 校验值。

Windows 10 2004 及以上 / Windows 11 x64；已包含 Node.js 和 FFmpeg。安装程序暂未进行商业代码签名。

### 主要能力

- DLNA / UPnP 和影视类 App HTTP 发现与投屏；基础 AirPlay 视频、HLS 和照片。
- 现代简洁的电脑接收页与手机网页遥控，支持深浅主题、媒体链接与本地文件上传。
- 播放、暂停、进度、音量、倍速、全屏和键盘快捷键；显示实际分辨率、FPS 和缓冲秒数。
- HLS 点播 60–90 秒前向缓冲、64 MiB 有界完整分片缓存、重复请求合并与网络恢复。
- 托盘后台、独立用户数据目录、进程退出清理、协议与成品验证脚本。
- 升级 XML 解析依赖并通过发布前依赖检查。

### 验证范围

已验证源码回归、真实 Edge 合成 HLS 视频在提前缓冲后的 8 秒源站中断、ZIP 独立启动和安装程序的安装/运行/卸载。网络持续低于片源码率时仍可能缓冲。

### 使用与兼容性

手机和电脑连接同一可信局域网；必要时允许 Windows 专用网络通信和手机 App 的本地网络权限。升级前请完全退出旧版后台。卸载默认保留 `%LOCALAPPDATA%\MobileTV\data` 中的用户文件。

基础 AirPlay **不包含苹果屏幕镜像、RAOP 或 FairPlay/DRM**，目前未完成苹果真机兼容性验证。WebRTC 共享需要浏览器支持和安全上下文；Miracast 入口使用 Windows 自带无线显示功能。

请阅读 [README](https://github.com/gemron/mobile-tv-screen#readme)、[协议兼容性](https://github.com/gemron/mobile-tv-screen#协议兼容性) 和 [第三方组件说明](https://github.com/gemron/mobile-tv-screen/blob/main/THIRD_PARTY_NOTICES.md)。自有源码采用 MIT，捆绑组件遵循各自许可证。
