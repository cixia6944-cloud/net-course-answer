// MD5(自包含实现, 零依赖)。用于超星字体解密: md5(JSON.stringify(glyphPath)).slice(24) → 查字形表。
// 输入为 JSON 字符串(纯 ASCII), 但仍按 UTF-8 编码处理以求通用。输出 32 位小写 hex。

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

/** UTF-8 编码为字节数组 */
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      // 代理对
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

function rotl(x, c) {
  return (x << c) | (x >>> (32 - c));
}

/**
 * 计算 MD5, 返回 32 位小写 hex。
 * @param {string} str 输入(按 UTF-8 编码)
 * @returns {string}
 */
export function md5(str) {
  const bytes = utf8Bytes(String(str));
  const bitLen = bytes.length * 8;
  // padding: 0x80, 补 0 到 len % 64 === 56, 再放 64 位小端长度
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push((bitLen / Math.pow(2, 8 * i)) & 0xff);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  const M = new Uint32Array(16);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] = bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D); g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C); g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D; g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D); g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }

  const hex = (n) => {
    let s = "";
    for (let i = 0; i < 4; i++) s += (((n >>> (i * 8)) & 0xff) + 0x100).toString(16).slice(1);
    return s;
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}
