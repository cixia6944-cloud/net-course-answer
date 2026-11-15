// 版本号 —— 唯一来源。
// 构建器把 meta.js 的 @version 从这里读; 面板状态栏也从这里读。
// 单独成文件是为了不让 ui/panel.js 把整段 UserScript 头(meta.js)拖进运行时产物。
export const VERSION = "0.12.7";
