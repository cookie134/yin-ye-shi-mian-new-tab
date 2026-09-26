# 因夜失眠标签页

**Yin Ye Shi Mian New Tab** — 一个默认保持安静的 Edge 新标签页扩展。

An Edge new tab page that stays quiet by default: local-first notes, reminders, a background gallery, and an AI assistant (Star) running on your own API key.

## 功能

### 首页

- 必应每日壁纸 / 单张网络图片 / 本地图库 / 纯色，四种背景来源
- 本地图片以**快照**形式存进扩展的 IndexedDB，不持续读取原文件夹；支持导入文件夹或多张图片，GIF / WebP / APNG 保持动画
- 图库可按顺序或随机轮播并可设间隔；自动轮播与滚轮切图**各自**可选淡入淡出 / 平移 / 缩放 / 无动画
- 时钟、日期、搜索引擎名称、搜索栏与短句的文字颜色与描边可调
- 内置百度、必应、Google、搜狗、360 搜索；支持自定义含 `{query}` 的 HTTPS 模板

### 收藏 Dock

- 底部 `+` 添加；长按拖动排序；拖入回收站删除
- 停在另一个收藏上可**创建文件夹**，拖到文件夹上可**加入文件夹**
- 图标三级降级：站点 `favicon.ico` → 浏览器 favicon 服务 → 首字母块
- 网页 / 链接右键菜单可收藏；支持标签栏右键的 Edge 版本也会显示同名菜单；点工具栏图标可收藏当前网页

### 便签与收纳

- 页面贴纸便签：拖动、自由缩放、局部文字格式（白名单清洗）、颜色、字体、字号、透明、最小化
- 每张便签可设**每日提醒**或**定时删除**；删除时间与单次提醒相同时，通知成功后再静默删除
- 左上角收纳默认折叠，可建多个收纳箱、改名、收纳 / 贴出

### 斯塔（Star）

- 六个 AI 服务：DeepSeek、OpenAI、Google Gemini、Groq、OpenRouter、自定义 OpenAI 兼容接口
- **每个服务分别保存 Key**，切换服务自动带出各自的地址与模型；从 `/models` 实时读取模型列表，按服务过滤出适合对话的模型，支持搜索与刷新
- 中央对话工作台：多会话、搜索、重命名、删除（二次确认）、消息可编辑或删除
- 未配置 API 时降级为**本地便签入口**，不调用任何模型
- 近期行程提示：本地先算，配置 API 后由模型改写，以浏览器通知呈现，并按「日期 + 指纹」去重

### 数据

- 导出配置**默认移除所有服务的 API Key**，且不含本地图片文件
- 导入时保留本机已有的 Key
- 旧结构有迁移路径：旧的单条便签草稿、旧的单会话聊天记录都会自动转换

---

## 安装

1. 从 [Releases](../../releases) 下载 zip 并解压（或直接使用本仓库目录）
2. 打开 `edge://extensions/`，开启**开发人员模式**
3. 点**加载解压缩的扩展**，选择解压后的目录
4. 打开一个新标签页

> 本仓库已包含编译产物 `dist/`，**无需构建即可加载**。

## 开发

需要 Node.js 20 以上。

```bash
npm install
npm run check           # tsc --noEmit，strict 模式
npm run build           # 编译 src/ → dist/

npm run test:home       # 首页 / 安静模式 / 短句
npm run test:reminders  # 提醒与闹钟
npm run test:snippets   # 短句队列（含伪造证据必须被拒、断网降级）
npm run test:background # 后台 service worker 与收藏文件夹
npm run test:provider   # AI 服务配置与斯塔动作
```

### 实现取舍

- **手写 TypeScript，无框架、无打包器。** 页面全部是命令式 DOM 渲染。代价是 `app.ts` 偏大（约 4200 行），收益是零运行时依赖、零构建链、产物可读。
- **写入串行化。** 所有落盘走一个 `saveQueue` 队列，并对状态做 `structuredClone` 快照，避免高频交互时整树覆写互相覆盖。
- **严格模式全开。** `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`。
- `background.js` **保持手写 JavaScript**，不参与编译——它的生命周期语义（随时被终止、无 DOM）与页面代码差异太大。

---

## 数据与隐私

- **没有开发者服务器。** 不含任何统计、分析或崩溃上报，开发者无法访问你的数据。
- 数据保存在你自己的浏览器中：`chrome.storage.local`（便签、提醒、收藏、聊天、设置、API Key）与 IndexedDB（本地背景图）。**未使用** `storage.sync`，不会同步到你的 Microsoft 账户。
- 数据离开设备的唯一场景是**你主动使用 AI 功能**：聊天内容、用于生成行程提示的便签正文与时间、以及由维基源料生成的首页短句，会发送到**你自己配置的 AI 服务**。这些内容在该服务端的处理方式，适用该服务自己的隐私政策。
- API Key 仅存于本机扩展存储，不会发送给开发者，也不写入导出文件。**请注意扩展本地存储不是加密保险箱。**
- 不读取浏览历史，不注入内容脚本，不修改任何网站页面。

---

## 技术栈

TypeScript（strict）· Manifest V3 · 原生 DOM · 无运行时依赖 · Node 内置测试运行器
