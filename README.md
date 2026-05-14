# A 股自选股监控面板

这是一个 Node.js 网页版自选股监控工具，启动后在浏览器里查看自选股行情、分时强弱、均线、昨日状态和买点/预警规则。

## 本地启动

需要 Node.js 18 或以上版本。

```powershell
npm start
```

打开：

```text
http://127.0.0.1:8787/
```

也可以直接双击 `start_dashboard.bat` 启动。

## 配置

项目内带有默认配置文件：

- `watchlist.json`：自选股列表和刷新间隔
- `buy_signals.json`：买点/预警规则

网页顶部的“自选股管理”可以直接新增股票、修改名称/备注、调整刷新秒数、删除股票。修改会写回 `watchlist.json`。

如果部署到云端，网页修改的是云端运行环境里的 `watchlist.json`。多数免费平台重启或重新部署后会恢复到 GitHub 仓库里的版本，所以长期保存仍建议把确认后的 `watchlist.json` 提交回 GitHub。

## 云端部署

这个项目需要 Node.js 服务端转发行情数据，不适合直接用 GitHub Pages 作为纯静态网页部署。

部署到 Render、Railway、Fly.io、VPS 等 Node.js 环境时：

- 启动命令：`npm start`
- 环境变量：`HOST=0.0.0.0`
- 端口：使用平台提供的 `PORT`，代码会自动读取

## 数据源

行情数据来自新浪行情接口。接口可用性、频率限制和数据延迟取决于第三方服务。
