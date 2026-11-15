# 第三方组件与分发

MobileTV 自有源码采用 MIT 许可证，第三方组件不因此变更其许可证。Windows 发行版会附带下列独立运行时和依赖。

| 组件 | 用途 | 许可与来源 |
| --- | --- | --- |
| Node.js | JavaScript 服务端运行时 | MIT 及其捆绑组件许可；[源码及完整 LICENSE](https://github.com/nodejs/node) |
| FFmpeg / Gyan Windows build | 生成诊断媒体、视频码流复制转封装、音频格式兼容 | 当前构建声明 GPL v3；[原始分发](https://github.com/GyanD/codexffmpeg/releases/tag/8.0.1)、[FFmpeg 源码](https://github.com/FFmpeg/FFmpeg/commit/894da5ca7d)、[构建说明与配置](https://www.gyan.dev/ffmpeg/builds/) |
| hls.js | HLS 播放 | Apache-2.0；[上游](https://github.com/video-dev/hls.js) |
| mpegts.js | FLV / MPEG-TS 浏览器播放能力 | Apache-2.0；[上游](https://github.com/xqq/mpegts.js) |
| Express、ws、bonjour-service、plist 等 | HTTP、WebSocket、发现与数据解析 | 以各 npm 包和传递依赖中的许可文件为准 |

打包脚本从实际使用的 Node.js 版本获取对应 LICENSE，并复制 FFmpeg 原始发行目录的 LICENSE、README（包含对应源码链接和构建配置）。`app/node_modules/` 中保留各包自带的许可文件，`THIRD-PARTY-NOTICES.txt` 列出锁定依赖及许可证标识。

发行版本、二进制 SHA-256 和实际 FFmpeg 构建名称还会写入 `build-info.json`。重新分发或修改发行包时，请保留这些许可、署名、源代码链接与原始组件分发要求，并核对所选二进制构建的对应源代码和依赖许可。

Inno Setup 仅用作构建工具；其安装器引擎遵循上游许可。[Inno Setup 源码与许可](https://github.com/jrsoftware/issrc)。
