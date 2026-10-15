# 发布预览版本

版本对应关系：源码 package/lock `0.1.0-preview.1` → 应用短版本 `0.1.0`、构建号 `2` → 预览标签 `v0.1.0-preview.1`。应用 Bundle Identifier 保持不变。

1. 确认工作区干净，检查本次改动、许可证和待发布版本。源码仓库只包含源码、测试、CI 与必要文档；依赖、缓存、日志、账号数据和安装包不提交 Git。
2. 按 README 安装锁定依赖并运行离线与原生测试，确认 GitHub CI 通过。CI 不连接真实网易云或执行账号写入。
3. 执行 `npm run build:panel` 和 `bash scripts/build-app.sh`，生成并验证密封应用 ZIP；执行 `bash scripts/package-source.sh` 生成干净已提交 HEAD 对应的源码 ZIP。ZIP 注释记录源提交。
4. 在产物目录执行 `shasum -a 256 网易云歌单整理应用.zip 网易云歌单整理源码.zip > SHA256SUMS.txt`，检查架构、版本、资源和签名。只分发密封 ZIP，避免保留多个裸构建应用入口。
5. 创建 `v0.1.0-preview.1` 标签，确认指向本次源码提交；新建 GitHub Release 并标记 pre-release，正文采用 [预览说明](RELEASE_NOTES.md)。上传应用 ZIP、源码 ZIP 和 SHA256SUMS.txt，核对附件后发布。
6. 明示支持客户端、ad-hoc/未公证、已知冷启动问题和实际测试范围。没有第二台 Mac 验证、Apple 公证或新图标，不应声称已完成这些项目。

日常构建和发布不需要重复实际账号写入。发布新版本涉及公开代码与附件，由维护者明确执行；CI 不自动创建 Release 或上传账号数据。
