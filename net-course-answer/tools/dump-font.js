// 超星加密字体导出器(F12 / Console 粘贴运行, 只读页面、不上传)。
// 用途: 把当前答题页的 font-cxsecret 字体 + 密文样本导出为文件, 便于离线复现解密链路
//       (拿到 cx-secret-0.ttf 后: node tools/font-selftest.mjs --font <该文件>)。
// 用法: 打开答题页(doHomeWorkNew) → F12 → Console → 粘贴本文件全部内容 → 回车。
//       浏览器会下载 cx-secret-0.ttf / cx-secret-style.css / cx-secret-text.txt。
// 注意: Edge 中文界面首次粘贴需在 Console 手打「允许粘贴」回车。
(function () {
  const out = { styles: 0, fonts: [], cipherElements: 0, chars: 0 };
  function save(name, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
    console.log("[dump-font] 已下载", name);
  }

  let styleCss = "";
  document.querySelectorAll("style").forEach((style) => {
    const txt = style.textContent || "";
    if (!txt.includes("font-cxsecret")) return;
    out.styles += 1;
    styleCss += txt;
    const re = /base64,([\w\W]+?)['")]/g;
    let m;
    let i = 0;
    while ((m = re.exec(txt))) {
      out.fonts.push(m[1]);
      save(`cx-secret-${out.fonts.length - 1}.ttf`, atob(m[1]), "font/ttf");
      i += 1;
    }
  });
  if (styleCss) save("cx-secret-style.css", styleCss, "text/css");

  let cipher = "";
  document.querySelectorAll(".font-cxsecret").forEach((el) => {
    out.cipherElements += 1;
    const t = el.textContent || "";
    out.chars += t.length;
    cipher += `${t}\n---\n`;
  });
  if (cipher) save("cx-secret-text.txt", cipher, "text/plain");

  console.log("[dump-font] 摘要", {
    ...out,
    fonts: out.fonts.map((f) => `${f.length} b64 chars`),
  });
  if (!out.fonts.length) console.warn("[dump-font] 未发现 font-cxsecret 字体(当前页可能没有加密题面)");
  return out;
})();
