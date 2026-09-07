# 知序 · 本地知识库

## macOS 启动

1. 安装 Node.js 22.13 或更高版本（Apple Silicon 和 Intel Mac 均可）。
2. 双击项目中的 `启动知识库网站.command`。首次启动会自动安装依赖；服务就绪后自动打开浏览器。
3. 将 Markdown 笔记放在用户主目录下的 `Note` 文件夹（`~/Note`）。首次启动会创建该文件夹，文件修改后自动同步。

启动后保留终端窗口；按 **Control+C** 或关闭窗口停止本次启动的服务。Mac 中搜索使用 **⌘K**，在编辑区保存使用 **⌘S**。

如果 Finder 提示没有执行权限，在项目目录打开终端运行：

```sh
chmod +x 启动知识库网站.command
./启动知识库网站.command
```

也可以在项目目录运行 `npm ci`，然后运行 `npm run dev`，手动访问 http://localhost:3000/。

## 指定笔记目录

复制 `.env.example` 为 `.env.local`，取消 `KNOWLEDGE_BASE_PATH` 行的注释并填写已有目录，例如：

```dotenv
KNOWLEDGE_BASE_PATH="~/Documents/我的笔记"
KNOWLEDGE_BASE_API_PORT=4312
```

支持中文、空格、`~/` 和相对于项目目录的路径。自定义目录需要提前创建。配置修改后重启服务；终端环境变量优先于 `.env.local`，其次是 `.env`。

从 Windows 迁移时，将整个笔记目录（含图片及 `.assets` 子目录）复制到 Mac，再更新路径。笔记中的相对图片路径支持正斜杠和反斜杠。网页编辑会直接保存到本地 Markdown 文件。

迁移项目时不要复制 Windows 的 `node_modules`；在 Mac 上运行 `npm ci` 安装对应平台的依赖。

## Windows

继续使用 `启动知识库网站.cmd` 或 `npm run dev`，默认读取 `E:\Note`。自定义目录同样可以通过 `.env.local` 配置。

## 常见问题

- 找不到 Node.js：启动入口会检查终端 PATH、Homebrew 的常见安装位置及默认 nvm 安装；其他版本管理器可在其已配置的终端运行 `npm run dev`。
- 端口占用：网站使用 3000，编辑服务默认使用 4312。关闭已有服务，或修改编辑服务端口后重启。重复双击 Mac 启动文件会复用同一项目、同一目录的已运行服务。
- 无法读取笔记：检查 `.env.local` 路径和目录权限；macOS 询问终端访问文稿或桌面文件夹时，允许访问所选笔记目录。
- 不想自动打开浏览器：运行 `ZHIXU_NO_BROWSER=1 ./启动知识库网站.command`。

## 本地验证

运行 `npm run test:local` 检查目录解析、文件监视、保存和图片读写。测试使用临时笔记，不会修改实际知识库。

## 飞书手动同步

重启本地启动程序后，点击网页右上角 **飞书同步**。仅在本地开发服务（`npm run dev` 或双击启动程序）中可用，线上 Sites 和 `npm start` 不提供本机文件同步。

### 首次连接

1. 在 [MyRobot 应用后台](https://open.feishu.cn/app/cli_aa03f00d80b89be9/baseinfo) 获取 App Secret；App ID 和知识库页面已预填。将密钥填写到网页的「连接配置」，点击「保存配置」。不需要在聊天中发送密钥。
2. 在应用的权限管理中开通 `wiki:wiki`、`docx:document`、`docx:document.block:convert`，创建并发布应用版本使权限生效。
3. 为应用授权目标知识库页面及子页面的阅读、编辑权限。**API 权限与文档资源权限是两回事**；参考[飞书知识库权限说明](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/wiki-v2/wiki-qa)。只将机器人添加到聊天群不能替代文档授权。
4. 点击「测试连接」。成功说明可以读取目标节点，写入权限会在第一次推送时验证。

网页配置存储在项目根目录 `.feishu-local.json`，文件权限为 `0600`（Windows 权限语义依系统而异），并已加入 Git 忽略。密钥不会返回给浏览器、写入笔记索引或存入浏览器缓存。也可以在 `.env.local` 中设置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_WIKI_URL`；这些值优先于网页配置，启用后网页配置只读。修改环境配置需重启服务。

### 按钮行为

| 操作 | 效果 |
| --- | --- |
| 从飞书导入 | 读取所配置页面及其所有子页面，将新版文档放到本地 `飞书/` 目录，按页面层级保存；文件名包含节点 token，避免同名覆盖。 |
| 推送当前笔记 | 首次在所配置页面下新建子页面，以后更新同一篇文档。只推送已保存正文，保留本地 YAML 标签等元数据。 |
| 拉取当前笔记 | 获取已关联文档的最新正文，保留本地 YAML 元数据。 |
| 另存为飞书新文档 | 创建新子页面并将当前笔记关联到新页面，原飞书文档保留，适合冲突后保留两份内容。 |

保存笔记不会触发飞书同步，也没有定时同步。不会传播文件删除、目录移动、文件重命名或标题变更。首次导入成功后，页面通过现有文件监视机制自动刷新。

支持文本、标题、粗体、斜体、链接、列表、待办、代码块及普通表格。Markdown 与飞书排版并非逐字节往返：例如列表序号、空行会规范化。图片、附件、提及、公式、评论、合并单元格及飞书专有内容不保证完整转换；导入会提示、保留原始文档块备份并禁止覆盖推送。当前版本含图片的笔记会在写入飞书前拒绝推送，不会悄悄丢弃图片。超出 1000 个文档块的笔记需要拆分后推送。

### 冲突与恢复

- 本地和飞书都修改过时，拉取不会覆盖本地，会在结果中显示冲突备份位置。你可以对照两端原文整理，再另存为飞书新文档。
- 飞书发生任何版本变化时，覆盖推送会停止，先拉取处理。本地仍有修改但飞书未变时，拉取会跳过，允许推送本地内容。
- 笔记目录内的 `.zhixu-feishu/state.json` 保存对应关系、上次内容摘要及飞书版本号；`backups/*.json` 保存导入原始块、被替换内容及冲突两份内容。该目录不会被笔记索引或图片复制读取。备份包含笔记正文，请随笔记妥善保管。
- 推送先插入新内容，确认后再移除旧内容。飞书多接口操作不是事务：同步期间请不要在其他窗口编辑同一篇文档。系统会检查版本并尽量中止并发修改；无法保证外部编辑与删除请求之间的极小竞争窗口完全消失。
- 网络中断或部分写入失败后会保留 `pending` 记录并禁止自动重试，避免重复创建或误删。对照结果中的备份和飞书版本历史恢复内容，确认一致后再修复该条同步记录。不要直接删除整个状态文件或备份目录。
- 如果程序异常退出，确认没有同步进程运行后，可移除 `.zhixu-feishu/sync.lock` 释放锁；该锁与 `pending` 是独立保护，释放锁不表示未完成的文档写入已经恢复。

### 接口与验证

使用飞书官方的[节点解析](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/get_node)、[知识库节点创建](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/create)、[文档块读取](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document-block/list)、[Markdown 转文档块](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document/convert)、[嵌套块写入](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document-block-descendant/create)接口。服务端使用应用身份的 `tenant_access_token`，缓存并刷新凭证，处理分页、限流与超时；不需要消息 Webhook 或公网回调。

`npm run test:feishu` 用隔离目录和模拟飞书响应验证同步、冲突、失败恢复保护和凭证隔离。它不会访问或修改实际飞书知识库；实际连通性与权限必须通过配置后的测试连接和一篇笔记的推送/拉取验证。
