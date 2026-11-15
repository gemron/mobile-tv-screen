# 5.8.8 功能、解析与网盘检查

检查日期：2026-11-15。此次核对版本与实际代码路径，修复发现的问题，并对用户配置作实时抽测。

## 参考版本

- 本机参考文件：`mobile-arm64_v8a.apk`，包名 `com.fongmi.android.tv`，`versionCode=588`，`versionName=5.8.8`，目标 SDK 37。
- APK SHA-256：`87f17bf151d2f4ad5a4936957fdf2ae9a3860f73eb91c037acb5acc8c72c849a`。
- 公开参考：FongMi/TV 提交 [`097917c1`](https://github.com/FongMi/TV/commit/097917c1c5eb6c94a14b2ede3f371a681dbb751f)，2026-11-13 标为 5.8.8。[版本声明](https://github.com/FongMi/TV/blob/097917c1c5eb6c94a14b2ede3f371a681dbb751f/app/build.gradle)。

本机文件的版本与包名已核实，但没有据此认定所有同名“OK影视”分支、签名或发行渠道都相同。本项目使用独立 Node.js 实现，不复制或捆绑参考项目的 Android 播放器代码、APK 和反编译文件。

## 发现与修复

| 项目 | 修复后的行为 |
| --- | --- |
| 手动解析 | 先执行源的播放解析，取得媒体或平台地址，再送到所选解析器；不把内部剧集编号直接传出去 |
| 解析器类型 | 支持 type 0 网页与 type 1 JSON；原先误列为普通 JSON 的 type 2 已纠正，2/3 扩展解析及 4 聚合解析明确显示未移植 |
| 解析前缀 | 支持 `playUrl`、`json:`、`parse:名称`，并处理 `jx` 与配置中的线路标志 |
| 多画质 | 接收交替名称/地址数组和 `values` 对象，保留默认位置；在播放器选择，切换时恢复进度 |
| 请求头 | 支持 JSON 字符串形式的头、`ua` 别名及解析器顶层头；为网页解析传递同源请求头，并隔离跨站账号凭据 |
| 媒体格式 | 处理返回的 `format`，识别无扩展名 HLS；声明为 HLS 但返回 HTML/JSON 时不计作可播放媒体 |
| 通用接口 | XML 使用 `ac=videolist`；HTTP API 传递 `extend`、URL-safe Base64 筛选，大扩展数据使用表单 POST；JSON 采集传递筛选 `f` |
| 比特片源 | 将网页接口请求头与媒体头分开，保留全部返回画质；修复 CDN 403，真实 Edge 抽测 1920×1080、播放时间持续前进 |
| 网盘会话 | 保存浏览器登录状态前实际检查会话，匿名 Cookie 不会被当作登录成功；失败同步不覆盖原账号 |
| 阿里令牌 | 合并并发刷新、保存刷新后的令牌；服务端拒绝旧访问令牌时仅刷新重试一次；账号切换后迟到结果不能覆盖新账号 |
| 网盘退出 | 清除所选平台的本机凭据及独立浏览器 Cookie/存储，保留其他平台会话；不撤销其他设备已持有的授权 |
| 网盘播放凭据 | 修复“我的网盘”入口切到其他平台时，误删该平台媒体接口所需 Cookie 的问题 |

协议核对依据：[SiteApi](https://github.com/FongMi/TV/blob/097917c1c5eb6c94a14b2ede3f371a681dbb751f/app/src/main/java/com/fongmi/android/tv/api/SiteApi.java)、[ParseJob](https://github.com/FongMi/TV/blob/097917c1c5eb6c94a14b2ede3f371a681dbb751f/app/src/main/java/com/fongmi/android/tv/player/parse/ParseJob.java)、[UrlAdapter](https://github.com/FongMi/TV/blob/097917c1c5eb6c94a14b2ede3f371a681dbb751f/app/src/main/java/com/fongmi/android/tv/gson/UrlAdapter.java)。

## 网盘实际检查范围

夸克、UC、阿里、百度四个官方页面均在独立 Edge 中成功加载并出现登录内容。没有读取用户日常浏览器的登录数据。

当前环境没有已保存的网盘账号，因此**没有完成四个平台的真实账号扫码授权和私人文件播放验收**。会话有效/失效、匿名 Cookie、状态保存、令牌刷新、过期重试、退出和账号切换隔离，通过本地协议服务与真实 Edge 的独立浏览器存储验证，不能将这些测试描述成已登录四个真实账号。

使用方式：**影视 → 网盘账号 → 打开官方登录页 → 在该窗口完成平台授权 → 保存浏览器登录状态 → 检查登录状态**。手动保存的资料会显示“尚未验证”，只有会话探测成功才显示上次检查通过的时间。

## 片源抽测

完整结果在 [JSON 检查记录](reports/source-check-2026-11-15.json)。共检查 49 个配置条目，按站点抽取一个目录/影片，纯搜索源补充一个关键词。检查区分目录、详情、解析地址、媒体清单/密钥/分片和真实解码，不能以 HTTP 200 或处理器接入数代替播放成功。

其中 23 个条目取得播放地址，21 个条目读取到媒体样本；这些条目包含直播、教育等分类入口，不是 21 个已经全部出画面的独立站点。比特另完成真实浏览器出画面检查，其余实播结果见逐项清单。

厂长仍有媒体 403，热播样本分片 404，部分旧站超时；海绵加密清单、AI剧原生链路、部分网盘搜索/分享接口仍未完整可用。真实网络结果会随上游、节目、权限和网络变化，失败样本不代表全站所有线路永久失效。

## 功能边界

此版已经覆盖点播/直播、基础投屏、网页和 JSON 解析、字幕之外的基础播放控制、多画质、广告过滤及网盘账号入口。以下尚不能与参考 Android 客户端等同：完整 JAR/JNI/QuickJS 运行环境、扩展与聚合解析、DRM/CENC 授权媒体、弹幕/字幕完整工作流、收藏历史、EPG/回看以及全部私有插件业务。

新增检查工具：

```powershell
node scripts/check-sources.js --url "自己的订阅地址" --json "source-report.json"
node scripts/check-sources.js --url "自己的订阅地址" --site "站点键" --keyword "片名"
npm test
npm run test:source-browser
npm run test:library:browser
```

媒体检查使用有上限的 GET 样本。CDN 拒绝 Range 时会再尝试普通 GET；清单最大 4 MiB，网络和层级均有限制。检查报告不输出完整媒体签名 URL、Cookie 或访问令牌，也不自动下载磁力内容。
