# 第三方组件与分发

MobileTV 1.2.1 起，有权授权的自有代码采用[学习研究与非商业使用许可证](LICENSE)，禁止商业售卖。此前已按 MIT 发布的代码保留原授权，第三方组件也不因此变更许可证；非商业限制不适用于下列独立运行时和依赖。

| 组件 | 用途 | 许可与来源 |
| --- | --- | --- |
| Node.js | JavaScript 服务端运行时 | MIT 及其捆绑组件许可；[源码及完整 LICENSE](https://github.com/nodejs/node) |
| FFmpeg / Gyan Windows build | 生成诊断媒体、视频码流复制转封装、音频格式兼容 | 当前构建声明 GPL v3；[原始分发](https://github.com/GyanD/codexffmpeg/releases/tag/8.0.1)、[FFmpeg 源码](https://github.com/FFmpeg/FFmpeg/commit/894da5ca7d)、[构建说明与配置](https://www.gyan.dev/ffmpeg/builds/) |
| hls.js | HLS 播放 | Apache-2.0；[上游](https://github.com/video-dev/hls.js) |
| mpegts.js | FLV / MPEG-TS 浏览器播放能力 | Apache-2.0；[上游](https://github.com/xqq/mpegts.js) |
| Cheerio | 站点 HTML 数据解析 | MIT；[上游](https://github.com/cheeriojs/cheerio) |
| Acorn | 仅提取订阅脚本中的数据字面量 | MIT；[上游](https://github.com/acornjs/acorn) |
| WebTorrent、fs-chunk-store | 磁力文件元数据、P2P 和有界临时缓存 | MIT；[WebTorrent](https://github.com/webtorrent/webtorrent)、[fs-chunk-store](https://github.com/webtorrent/fs-chunk-store) |
| jsonc-parser | 带注释的订阅配置解析 | MIT；[上游](https://github.com/microsoft/node-jsonc-parser) |
| Express、ws、bonjour-service、plist 等 | HTTP、WebSocket、发现与数据解析 | 以各 npm 包和传递依赖中的许可文件为准 |

打包脚本从实际使用的 Node.js 版本获取对应 LICENSE，并复制 FFmpeg 原始发行目录的 LICENSE、README（包含对应源码链接和构建配置）。`app/node_modules/` 中保留各包自带的许可文件，`THIRD-PARTY-NOTICES.txt` 列出锁定依赖及许可证标识。

发行版本、二进制 SHA-256 和实际 FFmpeg 构建名称还会写入 `build-info.json`。重新分发或修改发行包时，请保留这些许可、署名、源代码链接与原始组件分发要求，并核对所选二进制构建的对应源代码和依赖许可。

Inno Setup 仅用作构建工具；其安装器引擎遵循上游许可。[Inno Setup 源码与许可](https://github.com/jrsoftware/issrc)。

点播适配器为本项目的 Node.js 实现。仓库和发行包不包含第三方私有 Android JAR、DEX、ARM 库、反编译源码或默认内容订阅；用户导入的源和内容不因此变成本项目授权分发的资源。
