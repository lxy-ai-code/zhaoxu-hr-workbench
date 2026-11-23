# 招序 HR 工作台 Windows 版

在公司 GitHub 私有仓库的 **Releases** 下载 `ZhaoxuHR-v版本-windows-x64-Setup.exe`，双击安装。Windows x64 版已包含 Node.js 和 PDF、DOCX 文本解析器。安装完成后可从桌面或开始菜单打开 **Zhaoxu HR**。

首次使用时，招聘工作区为空。使用 BOSS 时，从开始菜单打开 **Zhaoxu HR BOSS Login** 并登录自己的账号，然后在工作台的系统配置里允许连接 BOSS。需要飞书功能时，在各自电脑安装飞书 CLI，完成授权后在工作台配置相应连接。独立机器人和模型凭据由经授权的人员在本机配置。

在开始菜单选择 **Zhaoxu HR Update** 可检查并安装新版。首次使用更新功能前，安装 [GitHub CLI](https://cli.github.com/) 并运行 `gh auth login --hostname github.com`，用有仓库读取权限的账号授权。也可以从 Releases 下载新版 Setup 安装。候选人资料、简历和配置保存在 `%LOCALAPPDATA%\ZhaoxuHR\data`，升级前会备份工作区 JSON。

此版本使用本机端口 `18788`。关闭浏览器页面后后台仍会运行。可以从开始菜单选择 **Zhaoxu HR Stop** 结束后台服务。Windows 重新登录后，从开始菜单打开工作台即可启动服务。

## 构建与发布

在 Windows x64 上使用 Node.js 22 以上运行：

```powershell
node.exe scripts/build-windows-release.mjs --version 1.0.0 --repository ORGANIZATION/REPOSITORY
```

发布同一版本的 Setup.exe、ZIP 和 ZIP 的 `.sha256` 文件。私有 Releases 是更新来源。包内程序与本地数据相互独立，每个发布版本使用新的版本号。
