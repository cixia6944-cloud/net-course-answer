(async () => {
  const { Typr } = await import('/src/vendor/typr.js');
  const { md5 } = await import('/src/vendor/md5.js');
  const { decryptFonts, __setTableForTest, getLastStats, getLastError } = await import('/src/core/font-decrypt.js');
  const buf = await (await fetch('/tools/fixtures/cx-test.ttf')).arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  const b64 = btoa(bin);
  const font = Typr.parse(buf)[0];
  const codes = [0x5d0, 0x5d1, 0x5d2, 0x5d3, 0x5d4, 0x5d5];
  const table = {};
  for (const cp of codes) {
    const gid = Typr.U.codeToGlyph(font, cp);
    if (!gid) continue;
    table[md5(JSON.stringify(Typr.U.glyphToPath(font, gid))).slice(24)] = cp + 100;
  }
  const style = document.createElement('style');
  style.textContent = '@font-face{font-family:"cxtest";src:url(data:font/ttf;base64,' + b64 + ") format('truetype');}.font-cxsecret{font-family:cxtest}";
  document.head.appendChild(style);
  const cipher = codes.map((c) => String.fromCharCode(c)).join('');
  const expect = codes.map((c) => String.fromCharCode(c + 100)).join('');
  const el = document.createElement('div');
  el.className = 'font-cxsecret';
  el.textContent = cipher;
  document.body.appendChild(el);
  __setTableForTest(table);
  const n = decryptFonts(document);
  return JSON.stringify({
    tableSize: Object.keys(table).length,
    decrypted: n,
    html: el.innerHTML,
    expect,
    pass: el.innerHTML === expect,
    classLeft: document.querySelectorAll('.font-cxsecret').length,
    stats: getLastStats(),
    err: getLastError(),
  });
})()
