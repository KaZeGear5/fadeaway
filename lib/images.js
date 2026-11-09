'use strict';
// Reconnaît le vrai type d'une image à ses premiers octets (on ne fait jamais confiance au nom ni au type annoncé).
// SVG volontairement refusé : il peut contenir du script.
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') {
    const head = buf.toString('latin1', 0, Math.min(buf.length, 4096));
    const actl = head.indexOf('acTL'), idat = head.indexOf('IDAT');
    return { ext: 'png', mime: 'image/png', animated: actl !== -1 && (idat === -1 || actl < idat) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg', animated: false };
  }
  const sig = buf.toString('latin1', 0, 6);
  if (sig === 'GIF87a' || sig === 'GIF89a') {
    // un GIF est toujours traité comme « animé » (même à une seule image)
    return { ext: 'gif', mime: 'image/gif', animated: true };
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const animated = buf.length > 21 && buf.toString('latin1', 12, 16) === 'VP8X' && (buf[20] & 0x02) !== 0;
    return { ext: 'webp', mime: 'image/webp', animated };
  }
  return null;
}

module.exports = { sniffImage };
